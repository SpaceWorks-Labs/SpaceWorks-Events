import "server-only";

import { OrderStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { enqueuePaymentEmail } from "../email";
import { formatMoney } from "../money";
import { COLLECTED, COMMITTED_REFUND, lockOrder, PaymentOperationError, ZERO } from "./shared";
import { recordRefundsTx, submitRefunds } from "./refund";

/*
 * Money left on orders that no longer hold tickets (docs/PAYMENTS.md
 * "Refundable orders"): a cancelled order refunded in part, or the expired
 * order of a payment that arrived too late. Listed and refunded by order, so
 * it works after the registrations are gone; confirmed orders are refunded
 * from the guest list.
 */

const ENDED: OrderStatus[] = [OrderStatus.CANCELLED, OrderStatus.EXPIRED];

/** Cancelled or expired orders with money still refundable on an event or series, newest first. */
export async function listRefundableOrders(owner: { eventId: string; } | { eventSeriesId: string; }, organisationId: string) {
  const orders = await prisma.order.findMany({
    where: { ...owner, organisationId, status: { in: ENDED }, payments: { some: { status: { in: COLLECTED } } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 200,
    select: {
      id: true, reference: true, status: true, buyerName: true, buyerEmail: true, currency: true, createdAt: true,
      payments: { where: { status: { in: COLLECTED } }, select: { amountMinor: true, refunds: { where: { status: { in: COMMITTED_REFUND } }, select: { amountMinor: true } } } },
    },
  });
  return orders.flatMap((order) => {
    const left = order.payments.reduce((sum, payment) => sum + payment.amountMinor - payment.refunds.reduce((total, refund) => total + refund.amountMinor, ZERO), ZERO);
    if (left <= ZERO) return [];
    return [{
      id: order.id,
      reference: order.reference,
      buyer: order.buyerName || order.buyerEmail,
      status: order.status === OrderStatus.CANCELLED ? "cancelled" as const : "expired" as const,
      left: formatMoney(left, order.currency),
      currency: order.currency,
      orderedAt: order.createdAt.toISOString(),
    }];
  }).slice(0, 100);
}

export type RefundableOrderRow = Awaited<ReturnType<typeof listRefundableOrders>>[number];

/**
 * Refund money left on a cancelled or expired order: balance only, its
 * tickets (if any are left) untouched. The same locks and ledger as every
 * refund: the organisation fence, the event (or series and dates), the order,
 * then its payments; the database guard refuses anything over what is left.
 * Online refunds go to the provider after commit.
 */
export async function refundEndedOrder(params: { orderId: string; organisationId: string; actorUserId: string; amountMinor: bigint | null; reason: string; now?: Date; }) {
  const now = params.now ?? new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, params.orderId);
    const order = await tx.order.findFirst({
      where: { id: params.orderId, organisationId: params.organisationId },
      select: { id: true, status: true, reference: true, buyerEmail: true, currency: true, payments: { where: { status: { in: COLLECTED } }, orderBy: { paidAt: "asc" }, select: { id: true, status: true, amountMinor: true } } },
    });
    if (!order) throw new PaymentOperationError("Order not found.");
    if (!ENDED.includes(order.status)) throw new PaymentOperationError("Only cancelled or expired orders are refunded here. Refund confirmed orders from the guest list.");
    if (params.amountMinor === ZERO) throw new PaymentOperationError("Enter an amount to refund.");
    const { wanted, onlineRefundIds, refundedPaymentId } = await recordRefundsTx(tx, order.payments, { wanted: params.amountMinor, currency: order.currency, reason: params.reason, actorUserId: params.actorUserId, now });
    if (wanted === ZERO || !refundedPaymentId) throw new PaymentOperationError("There is nothing left to refund on this order.");
    await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: refundedPaymentId, notice: "refunded" });
    await notifyChat(tx, params.organisationId, "refund", `Refund of ${formatMoney(wanted, order.currency)} on ${order.status === OrderStatus.CANCELLED ? "cancelled" : "expired"} order ${order.reference} for ${order.buyerEmail}. Reason: ${params.reason.slice(0, 200)}`);
    await recordAuditEvent({
      action: "PAYMENT_REFUNDED", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Order", targetId: order.id,
      metadata: { amountMinor: wanted.toString(), cancelled: false, endedOrder: true }, client: tx,
    });
    return { onlineRefundIds, refundedMinor: wanted };
  });
  await submitRefunds(outcome.onlineRefundIds);
  return { refundedMinor: outcome.refundedMinor };
}
