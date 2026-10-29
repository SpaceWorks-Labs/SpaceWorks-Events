import "server-only";

import { OrderLineKind, OrderStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isPaidEventsEnabled } from "@/lib/instanceSettings";
import { startCheckout } from "./checkout";
import { ENTRY_FEE_LINE, entryFeePaid } from "./entryFees";
import { CHECKOUT_HOLD_MS, HOLD_EXTENSION_CAP_MS } from "./holds";
import { DEFAULT_CURRENCY } from "./money";
import { newOrderReference } from "./orders";
import { loadPaymentAccount } from "./settings";
import { fenceOrganisation } from "./targets";

const UNAVAILABLE = "Entry fees can't be paid right now. Contact the organisers.";

/**
 * Open the provider's checkout for a project's entry fee: a live hold is
 * reused, and a fee already paid means nothing is owed.
 */
export async function openEntryFeeCheckout(params: {
  eventId: string;
  submissionId: string;
  buyer: { userId: string | null; email: string; name: string; };
}): Promise<{ url: string; } | { paid: true; } | { error: string; }> {
  if (!(await isPaidEventsEnabled())) return { error: UNAVAILABLE };
  const event = await prisma.event.findUnique({ where: { id: params.eventId }, select: { organisationId: true, title: true, currency: true, submissionFeeMinor: true } });
  if (!event?.submissionFeeMinor) return { paid: true };
  const fee = event.submissionFeeMinor;
  const account = await loadPaymentAccount(event.organisationId);
  if (!account) return { error: UNAVAILABLE };
  const now = new Date();
  const orderId = await prisma.$transaction(async (tx) => {
    // The organisation fence, then the event (docs/PAYMENTS.md lock order).
    if (!(await fenceOrganisation(tx, event.organisationId))) return "gone" as const;
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${params.eventId} FOR UPDATE`;
    if (await entryFeePaid(tx, params.submissionId)) return null;
    const held = await tx.order.findFirst({ where: { submissionId: params.submissionId, status: OrderStatus.PENDING, holdExpiresAt: { gt: now } }, select: { id: true } });
    if (held) return held.id;
    const currency = event.currency ?? DEFAULT_CURRENCY;
    const holdExpiresAt = new Date(now.getTime() + CHECKOUT_HOLD_MS);
    const order = await tx.order.create({
      data: {
        organisationId: event.organisationId, eventId: params.eventId, submissionId: params.submissionId, reference: newOrderReference(),
        buyerUserId: params.buyer.userId, buyerEmail: params.buyer.email, buyerName: params.buyer.name.slice(0, 200),
        status: OrderStatus.PENDING, currency, subtotalMinor: fee, totalMinor: fee, testMode: account.testMode,
        holdExpiresAt, holdCapAt: new Date(holdExpiresAt.getTime() + HOLD_EXTENSION_CAP_MS),
        lines: { create: [{ kind: OrderLineKind.FEE, description: ENTRY_FEE_LINE, quantity: 1, unitMinor: fee, totalMinor: fee }] },
      },
      select: { id: true },
    });
    await tx.payment.create({
      data: { organisationId: event.organisationId, orderId: order.id, amountMinor: fee, currency, provider: account.provider, testMode: account.testMode, description: `${ENTRY_FEE_LINE}: ${event.title}`.slice(0, 300) },
    });
    return order.id;
  });
  if (orderId === "gone") return { error: UNAVAILABLE };
  if (!orderId) return { paid: true };
  const checkout = await startCheckout(orderId).catch(() => null);
  return checkout && "url" in checkout ? { url: checkout.url } : { error: "The payment page couldn't open. Try again in a minute." };
}
