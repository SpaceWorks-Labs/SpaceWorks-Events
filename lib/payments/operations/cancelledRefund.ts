import "server-only";

import { OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { enqueuePaymentEmail } from "../email";
import { formatMoney } from "../money";
import { COLLECTED, lockOrder, PaymentOperationError, ZERO } from "./shared";
import { recordRefundsTx, submitRefunds } from "./refund";
import { refundableBalanceSql, refundableOrderSql } from "../refundableBalance";

/*
 * Money left on orders that no longer hold tickets (docs/PAYMENTS.md
 * "Refundable orders"): a cancelled order refunded in part, or the expired
 * order of a payment that arrived too late. Listed and refunded by order, so
 * it works after the registrations are gone. Checked-in orders on cancelled
 * targets are refunded here without removing tickets.
 */

/** Filter balances before limiting: exhausted orders can never hide older money. */
export async function listRefundableOrders(owner: { eventId: string; } | { eventSeriesId: string; }, organisationId: string) {
  const scope = "eventId" in owner ? Prisma.sql`o."eventId" = ${owner.eventId}` : Prisma.sql`o."eventSeriesId" = ${owner.eventSeriesId}`;
  const orders = await prisma.$queryRaw<Array<{
    id: string; reference: string; status: OrderStatus; buyerName: string; buyerEmail: string; currency: string; createdAt: Date; remaining: bigint;
  }>>`SELECT o."id", o."reference", o."status", o."buyerName", o."buyerEmail", o."currency", o."createdAt", b.remaining
    FROM "Order" o CROSS JOIN LATERAL (SELECT ${refundableBalanceSql} AS remaining) b
    WHERE o."organisationId" = ${organisationId} AND ${scope} AND ${refundableOrderSql} AND b.remaining > 0
    ORDER BY o."createdAt" DESC, o."id" DESC LIMIT 100`;
  return orders.map((order) => ({
    id: order.id,
    reference: order.reference,
    buyer: order.buyerName || order.buyerEmail,
    status: order.status === OrderStatus.CANCELLED ? "cancelled" as const : order.status === OrderStatus.EXPIRED ? "expired" as const : "confirmed" as const,
    left: formatMoney(order.remaining, order.currency),
    currency: order.currency,
    orderedAt: order.createdAt.toISOString(),
  }));
}

export type RefundableOrderRow = Awaited<ReturnType<typeof listRefundableOrders>>[number];

/**
 * Refund money left on an ended order or a cancelled target: balance only, its
 * tickets (if any are left) untouched. The same locks and ledger as every
 * refund: the organisation fence, the event (or series and dates), the order,
 * then its payments; the database guard refuses anything over what is left.
 * Online refunds go to the provider after commit.
 */
export async function refundEndedOrder(params: { orderId: string; organisationId: string; actorUserId: string; amountMinor: bigint | null; reason: string; now?: Date; }) {
  const now = params.now ?? new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, params.orderId);
    const eligible = await tx.$queryRaw<Array<{ id: string }>>`SELECT o."id" FROM "Order" o
      WHERE o."id" = ${params.orderId} AND o."organisationId" = ${params.organisationId} AND ${refundableOrderSql}`;
    const order = await tx.order.findFirst({
      where: { id: params.orderId, organisationId: params.organisationId },
      select: { id: true, status: true, reference: true, buyerEmail: true, currency: true, payments: { where: { status: { in: COLLECTED } }, orderBy: { paidAt: "asc" }, select: { id: true, status: true, amountMinor: true } } },
    });
    if (!order) throw new PaymentOperationError("Order not found.");
    if (!eligible.length) throw new PaymentOperationError("Only cancelled or expired orders, or orders on cancelled events or dates, are refunded here. Refund other confirmed orders from the guest list.");
    if (params.amountMinor === ZERO) throw new PaymentOperationError("Enter an amount to refund.");
    const { wanted, onlineRefundIds, refundedPaymentId } = await recordRefundsTx(tx, order.payments, { wanted: params.amountMinor, currency: order.currency, reason: params.reason, actorUserId: params.actorUserId, now });
    if (wanted === ZERO || !refundedPaymentId) throw new PaymentOperationError("There is nothing left to refund on this order.");
    await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: refundedPaymentId, notice: "refunded" });
    await notifyChat(tx, params.organisationId, "refund", `Refund of ${formatMoney(wanted, order.currency)} on ${order.status === OrderStatus.CANCELLED ? "cancelled" : order.status === OrderStatus.EXPIRED ? "expired" : "cancelled event or date"} order ${order.reference} for ${order.buyerEmail}. Reason: ${params.reason.slice(0, 200)}`);
    await recordAuditEvent({
      action: "PAYMENT_REFUNDED", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Order", targetId: order.id,
      metadata: { amountMinor: wanted.toString(), cancelled: false, endedOrder: order.status !== OrderStatus.CONFIRMED, cancelledTarget: order.status === OrderStatus.CONFIRMED }, client: tx,
    });
    return { onlineRefundIds, refundedMinor: wanted };
  });
  await submitRefunds(outcome.onlineRefundIds);
  return { refundedMinor: outcome.refundedMinor };
}
