import "server-only";

import crypto from "crypto";
import { CheckoutAttemptStatus, type Prisma } from "@prisma/client";
import { emitWebhookEvent, type WebhookEmission } from "@/lib/webhooks/emit";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import type { OnlineProvider } from "./http";
import { verifyRazorpayWebhook } from "./providers/razorpay";
import { verifyStripeWebhook } from "./providers/stripe";
import { WebhookVerificationError, type VerifiedWebhookEvent } from "./providers/types";
import { applyDisputeNotification } from "./disputes";
import { applyRefundNotification, submitPendingRefund } from "./refunds";
import { isWebhookPathId, webhookSecretForPath } from "./settings";
import { settlePaidNotification } from "./settlement";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function empty(status: number) {
  return new NextResponse(null, { status, headers: HEADERS });
}

/** The exact request bytes, capped. Signatures cover these bytes, not a parsed body. */
async function readRawBody(request: Request): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_WEBHOOK_BYTES || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_WEBHOOK_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function verifyWebhook(provider: OnlineProvider, secret: string, rawBody: Buffer, headers: Headers): VerifiedWebhookEvent {
  return provider === "RAZORPAY" ? verifyRazorpayWebhook(secret, rawBody, headers) : verifyStripeWebhook(secret, rawBody, headers);
}

export type WebhookContext = { organisationId: string; provider: OnlineProvider; };

/**
 * Applies a verified event inside the transaction that records it, so a
 * failure rolls back the idempotency row and the provider retries. Returns
 * refunds to submit to the provider once the transaction has committed.
 */
export type WebhookApplier = (tx: Prisma.TransactionClient, context: WebhookContext, event: VerifiedWebhookEvent) => Promise<{ refundIds: string[]; webhooks: WebhookEmission[]; } | void>;

/**
 * POST /api/webhooks/{razorpay,stripe}/:webhookPathId on the API host.
 * The path only addresses the organisation; that organisation's own secret
 * must verify the raw body before anything is parsed or stored. Verified
 * events are recorded once per (organisation, provider, event id).
 */
export async function handleProviderWebhook(request: Request, provider: OnlineProvider, webhookPathId: string, apply?: WebhookApplier) {
  if (!isWebhookPathId(webhookPathId)) return empty(404);
  const rawBody = await readRawBody(request);
  if (!rawBody) return empty(413);
  const account = await webhookSecretForPath(webhookPathId, provider);
  if (!account) return empty(404);

  let event: VerifiedWebhookEvent;
  try {
    event = verifyWebhook(provider, account.secret, rawBody, request.headers);
  } catch (error) {
    if (error instanceof WebhookVerificationError) return empty(400);
    throw error;
  }

  const context = { organisationId: account.organisationId, provider };
  let refundIds: string[] = [];
  let webhooks: WebhookEmission[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      // ON CONFLICT keeps a replay distinct from a failure inside `apply`,
      // which must roll back and be retried by the provider.
      const inserted = await tx.$queryRaw<Array<{ id: string; }>>`
        INSERT INTO "ProcessedWebhookEvent" ("id", "organisationId", "provider", "eventId", "eventType")
        VALUES (${crypto.randomUUID()}, ${account.organisationId}, ${provider}::"PaymentProvider", ${event.eventId.slice(0, 255)}, ${event.eventType || "unknown"})
        ON CONFLICT ("organisationId", "provider", "eventId") DO NOTHING
        RETURNING "id"
      `;
      if (inserted.length === 0) return;
      const applied = await apply?.(tx, context, event);
      refundIds = applied?.refundIds ?? [];
      webhooks = applied?.webhooks ?? [];
    });
  } catch {
    console.error(`[payments] ${provider.toLowerCase()} webhook could not be applied`);
    return empty(500);
  }
  // Provider calls happen outside the transaction; the scheduler retries any left pending.
  for (const refundId of refundIds) await submitPendingRefund(refundId).catch(() => undefined);
  for (const webhook of webhooks) emitWebhookEvent(webhook);
  return NextResponse.json({ received: true }, { headers: HEADERS });
}

/** Settlement for verified webhooks: captured payments, closed pages, then refund updates. */
export const settleWebhookEvent: WebhookApplier = async (tx, context, event) => {
  const refundIds: string[] = [];
  const webhooks: WebhookEmission[] = [];
  if (event.paid) {
    const settled = await settlePaidNotification(tx, context, event.paid);
    refundIds.push(...settled.refundIds);
    webhooks.push(...(settled.webhooks ?? []));
  }
  if (event.closedCheckoutId) {
    // The page can no longer take money; the hold itself ends on its own schedule.
    await tx.paymentCheckoutAttempt.updateMany({
      where: { provider: context.provider, externalId: event.closedCheckoutId, status: CheckoutAttemptStatus.OPEN, payment: { organisationId: context.organisationId } },
      data: { status: CheckoutAttemptStatus.EXPIRED },
    });
  }
  for (const refund of event.refunds) await applyRefundNotification(tx, context, refund);
  if (event.dispute) await applyDisputeNotification(tx, context, event.dispute);
  return { refundIds, webhooks };
};
