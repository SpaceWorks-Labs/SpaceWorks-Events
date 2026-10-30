import "server-only";

import { OrderStatus, PaymentRefundStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { formatMoney } from "../money";
import { lockRefundPayment, submitPendingRefund } from "../refunds";
import { COLLECTED, COMMITTED_REFUND, PaymentOperationError, ZERO } from "./shared";

const RETRYABLE_ORDERS: OrderStatus[] = [OrderStatus.CONFIRMED, OrderStatus.CANCELLED, OrderStatus.EXPIRED];

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: string; }).code === "P2002";
}

/**
 * Retry a refund the provider refused (docs/PAYMENTS.md): a new PENDING
 * refund for the same amount, pointing at the failed one, which never
 * changes. Each failed refund is retried once (`retryOfRefundId` is unique,
 * and the payment lock makes a second retry see the first); the database
 * guard still refuses anything over what is left on the payment. Works on
 * confirmed and cancelled orders alike (a cancelled order's tickets are
 * already gone), and on a late payment's expired order. The provider is
 * called after commit.
 */
export async function retryFailedRefund(params: { refundId: string; organisationId: string; actorUserId: string; }) {
  let retryId: string;
  try {
    retryId = await prisma.$transaction(async (tx) => {
      if (!(await lockRefundPayment(tx, params.refundId))) throw new PaymentOperationError("Refund not found.");
      const failed = await tx.paymentRefund.findFirst({
        where: { id: params.refundId, payment: { organisationId: params.organisationId } },
        select: {
          id: true, status: true, offline: true, amountMinor: true, reason: true, automatic: true, retry: { select: { id: true } },
          payment: { select: { id: true, status: true, amountMinor: true, currency: true, refunds: { where: { status: { in: COMMITTED_REFUND } }, select: { amountMinor: true } }, order: { select: { id: true, status: true, reference: true, buyerEmail: true } } } },
        },
      });
      if (!failed) throw new PaymentOperationError("Refund not found.");
      const { payment } = failed;
      if (failed.status !== PaymentRefundStatus.FAILED || failed.offline) throw new PaymentOperationError("Only a refund the provider refused can be retried.");
      if (failed.retry) throw new PaymentOperationError("This refund has already been retried.");
      // Confirmed or cancelled orders, and the expired order of a payment that arrived too late.
      if (!COLLECTED.includes(payment.status) || !RETRYABLE_ORDERS.includes(payment.order.status)) throw new PaymentOperationError("This order can't be refunded.");
      const left = payment.amountMinor - payment.refunds.reduce((sum, refund) => sum + refund.amountMinor, ZERO);
      if (failed.amountMinor > left) throw new PaymentOperationError(`Only ${formatMoney(left, payment.currency)} is left to refund on this payment.`);
      const retry = await tx.paymentRefund.create({
        data: { paymentId: payment.id, amountMinor: failed.amountMinor, reason: `Retry: ${failed.reason}`.slice(0, 500), automatic: failed.automatic, createdByUserId: params.actorUserId, retryOfRefundId: failed.id },
        select: { id: true },
      });
      await notifyChat(tx, params.organisationId, "refund", `Retrying a failed refund of ${formatMoney(failed.amountMinor, payment.currency)} on order ${payment.order.reference} for ${payment.order.buyerEmail}.`);
      await recordAuditEvent({ action: "PAYMENT_REFUND_RETRIED", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "PaymentRefund", targetId: retry.id, metadata: { retryOf: failed.id, orderId: payment.order.id, amountMinor: failed.amountMinor.toString() }, client: tx });
      return retry.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new PaymentOperationError("This refund has already been retried.");
    throw error;
  }
  await submitPendingRefund(retryId).catch(() => undefined);
  return { refundId: retryId };
}

/**
 * Refunds the provider refused and nobody has retried yet, newest first, on
 * an event's or a series' orders: the Failed refunds list, which stays
 * reachable after the order's tickets were cancelled.
 */
export async function listFailedRefunds(owner: { eventId: string; } | { eventSeriesId: string; }, organisationId: string) {
  const rows = await prisma.paymentRefund.findMany({
    where: { status: PaymentRefundStatus.FAILED, offline: false, retry: null, payment: { organisationId, order: owner } },
    orderBy: [{ settledAt: "desc" }, { id: "desc" }],
    take: 100,
    select: { id: true, amountMinor: true, reason: true, settledAt: true, payment: { select: { currency: true, order: { select: { reference: true, buyerName: true, buyerEmail: true, status: true } } } } },
  });
  return rows.map((row) => ({
    id: row.id,
    amount: formatMoney(row.amountMinor, row.payment.currency),
    reason: row.reason,
    failedAt: row.settledAt?.toISOString() ?? null,
    reference: row.payment.order.reference,
    buyer: row.payment.order.buyerName || row.payment.order.buyerEmail,
    orderCancelled: row.payment.order.status === OrderStatus.CANCELLED,
  }));
}

export type FailedRefundRow = Awaited<ReturnType<typeof listFailedRefunds>>[number];
