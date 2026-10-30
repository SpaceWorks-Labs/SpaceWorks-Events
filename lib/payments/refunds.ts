import "server-only";

import { PaymentRefundStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { noticeEach, organiserEmails } from "@/lib/notices";
import { notifyChat } from "@/lib/chat/notify";
import { PaymentsUnavailable, type OnlineProvider } from "./http";
import { formatMoney } from "./money";
import type { RefundNotification } from "./providers/types";
import { loadPaymentAccount } from "./settings";

/** A refund claimed this recently is assumed to be in flight on another worker. */
const SUBMISSION_LEASE_MS = 2 * 60_000;

/**
 * Step 1 of a refund, inside the caller's transaction (which holds the
 * payment row lock): record a PENDING row. The database trigger refuses it if
 * pending plus succeeded refunds would exceed the payment. The provider is
 * called afterwards, outside any lock, by submitPendingRefund.
 */
export async function createPendingRefund(tx: Prisma.TransactionClient, params: {
  paymentId: string;
  amountMinor: bigint;
  reason: string;
  automatic?: boolean;
  createdByUserId?: string | null;
}) {
  return tx.paymentRefund.create({
    data: {
      paymentId: params.paymentId,
      amountMinor: params.amountMinor,
      reason: params.reason.slice(0, 500),
      automatic: params.automatic ?? false,
      createdByUserId: params.createdByUserId ?? null,
    },
    select: { id: true },
  });
}

/**
 * Lock a refund's payment row, the first lock of every refund write: the
 * ledger trigger locks Payment after any PaymentRefund write, so writing the
 * refund row first would take the two in the opposite order (docs/PAYMENTS.md).
 */
export async function lockRefundPayment(tx: Prisma.TransactionClient, refundId: string) {
  const row = await tx.paymentRefund.findUnique({ where: { id: refundId }, select: { paymentId: true } });
  if (row) await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${row.paymentId} FOR UPDATE`;
  return row;
}

/**
 * Settle a PENDING refund from the provider's answer, under the payment lock.
 * Only a row this call changed is audited and told about, so a webhook, a
 * retry and maintenance never send the same failure notice twice.
 */
export async function settleRefundRow(refundId: string, organisationId: string, result: { refundId?: string; state: "PENDING" | "SUCCEEDED" | "FAILED"; }, now: Date) {
  return prisma.$transaction(async (tx) => {
    if (!(await lockRefundPayment(tx, refundId))) return false;
    const changed = await tx.paymentRefund.updateMany({
      where: { id: refundId, status: PaymentRefundStatus.PENDING },
      data: { ...(result.refundId ? { externalRefundId: result.refundId } : {}), status: result.state, settledAt: result.state === "PENDING" ? null : now },
    });
    if (changed.count === 1 && result.state === PaymentRefundStatus.FAILED) {
      await recordAuditEvent({ action: "PAYMENT_REFUND_FAILED", organisationId, targetType: "PaymentRefund", targetId: refundId, client: tx });
      await noticeRefundFailed(tx, refundId);
    }
    return changed.count === 1;
  });
}

/**
 * Steps 2 and 3: ask the provider, then settle the row from its answer.
 * Safe to call repeatedly (the outbox tick retries anything left pending): a
 * lease stops two workers submitting at once, and a refund that was already
 * submitted is first looked up by our id so money is never returned twice.
 * Every write locks the payment first; the provider is called outside them.
 */
export async function submitPendingRefund(refundId: string): Promise<"submitted" | "skipped" | "failed"> {
  const now = new Date();
  const refund = await prisma.paymentRefund.findUnique({
    where: { id: refundId },
    select: {
      id: true, amountMinor: true, status: true, offline: true, externalRefundId: true, submittedAt: true,
      payment: { select: { id: true, organisationId: true, provider: true, currency: true, externalPaymentId: true } },
    },
  });
  if (!refund || refund.status !== PaymentRefundStatus.PENDING || refund.offline || refund.externalRefundId) return "skipped";
  if (refund.submittedAt && refund.submittedAt.getTime() > now.getTime() - SUBMISSION_LEASE_MS) return "skipped";
  // Optimistic claim on the previous submission time: only one worker wins.
  const claimed = await prisma.$transaction(async (tx) => {
    await lockRefundPayment(tx, refund.id);
    return tx.paymentRefund.updateMany({
      where: { id: refund.id, status: PaymentRefundStatus.PENDING, externalRefundId: null, submittedAt: refund.submittedAt },
      data: { submittedAt: now },
    });
  });
  if (claimed.count !== 1) return "skipped";
  const isRetry = refund.submittedAt !== null;
  const { payment } = refund;
  if (payment.provider === "OFFLINE" || !payment.externalPaymentId) return "skipped";
  const account = await loadPaymentAccount(payment.organisationId, payment.provider as OnlineProvider);
  if (!account) return "skipped";

  let result: Awaited<ReturnType<typeof account.gateway.createRefund>> | null = null;
  // An earlier attempt may have reached the provider before failing here. A
  // lookup that fails in any way (a timeout, or a refusal such as a 401 while
  // the keys are wrong) proves nothing about that refund: it stays pending,
  // its amount still committed, and is looked up again on the next tick.
  if (isRetry) {
    try {
      result = await account.gateway.findRefund(payment.externalPaymentId, refund.id);
    } catch {
      return "skipped";
    }
  }
  try {
    result ??= await account.gateway.createRefund({
      paymentId: payment.externalPaymentId,
      amountMinor: refund.amountMinor,
      currency: payment.currency,
      reference: refund.id,
      idempotencyKey: `refund:${refund.id}`,
    });
  } catch (error) {
    // Only the provider definitely refusing to create it (for example the
    // balance is too low) fails the row, which is what lets an organiser
    // retry it; anything else stays pending and is retried on the next tick.
    if (error instanceof PaymentsUnavailable && error.status && error.status >= 400 && error.status < 500 && error.status !== 409 && error.status !== 429) {
      return (await settleRefundRow(refund.id, payment.organisationId, { state: PaymentRefundStatus.FAILED }, new Date())) ? "failed" : "skipped";
    }
    return "skipped";
  }
  const changed = await settleRefundRow(refund.id, payment.organisationId, result, new Date());
  if (result.state !== PaymentRefundStatus.FAILED) return "submitted";
  return changed ? "failed" : "skipped";
}

/**
 * Applies a verified refund webhook. Only refunds this organisation created
 * are matched: by the provider's refund id, or by our id echoed in its
 * metadata, always within the organisation and provider.
 */
export async function applyRefundNotification(tx: Prisma.TransactionClient, context: { organisationId: string; provider: OnlineProvider; }, notification: RefundNotification) {
  const refund = await tx.paymentRefund.findFirst({
    where: {
      payment: { organisationId: context.organisationId, provider: context.provider },
      OR: [{ externalRefundId: notification.refundId }, ...(notification.reference ? [{ id: notification.reference }] : [])],
    },
    select: { id: true, paymentId: true, status: true, externalRefundId: true, payment: { select: { externalPaymentId: true } } },
  });
  if (!refund) return;
  if (notification.paymentId && refund.payment.externalPaymentId && notification.paymentId !== refund.payment.externalPaymentId) return;
  if (refund.externalRefundId && refund.externalRefundId !== notification.refundId) return;
  await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${refund.paymentId} FOR UPDATE`;
  if (refund.status !== PaymentRefundStatus.PENDING) return;
  const changed = await tx.paymentRefund.updateMany({
    where: { id: refund.id, status: PaymentRefundStatus.PENDING },
    data: {
      externalRefundId: notification.refundId,
      status: notification.state,
      settledAt: notification.state === "PENDING" ? null : new Date(),
    },
  });
  // Only the delivery that changed the row tells anyone.
  if (changed.count === 1 && notification.state === "FAILED") {
    await recordAuditEvent({ action: "PAYMENT_REFUND_FAILED", organisationId: context.organisationId, targetType: "PaymentRefund", targetId: refund.id, client: tx });
    await noticeRefundFailed(tx, refund.id);
  }
}

/** A refund the provider refused: the organisation's owners and admins are told, so the buyer isn't left waiting. */
async function noticeRefundFailed(client: Prisma.TransactionClient, refundId: string) {
  const refund = await client.paymentRefund.findUnique({
    where: { id: refundId },
    select: { amountMinor: true, payment: { select: { currency: true, organisationId: true, order: { select: { reference: true, buyerEmail: true } } } } },
  });
  if (!refund) return;
  const { payment } = refund;
  await notifyChat(client, payment.organisationId, "refund", `A refund of ${formatMoney(refund.amountMinor, payment.currency)} on order ${payment.order.reference} failed: the payment provider refused it. Retry it from Failed refunds in the event's Finance tab, or on the series page.`);
  await noticeEach(client, await organiserEmails(client, payment.organisationId), {
    organisationId: payment.organisationId,
    subject: `A refund failed: order ${payment.order.reference}`,
    lines: [
      `The payment provider refused a refund of ${formatMoney(refund.amountMinor, payment.currency)} on order ${payment.order.reference} (${payment.order.buyerEmail}).`,
      "Check your balance with the provider, then choose Retry refund under Failed refunds in the event's Finance tab (or on the series page), or refund the buyer another way.",
    ],
  });
}
