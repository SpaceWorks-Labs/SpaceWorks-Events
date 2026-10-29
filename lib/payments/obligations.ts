import "server-only";

import { EventStatus, OrderStatus, PaymentRefundStatus, PaymentStatus, type Prisma } from "@prisma/client";
import { cancelledTargetSql, refundableBalanceSql } from "./refundableBalance";

/*
 * What still ties an organisation to money (docs/PAYMENTS.md "Deleting"):
 * deleting it would erase the orders, payments and refunds that record it,
 * and the payment settings that finish it. Read inside the deletion
 * transaction, after the Organisation row lock that every order and payment
 * path's fence waits on, so nothing new can appear between the check and the
 * cascade.
 */

const COMMITTED: PaymentRefundStatus[] = [PaymentRefundStatus.PENDING, PaymentRefundStatus.SUCCEEDED];

/** Why the organisation can't be deleted yet, or null when nothing is owed or in flight. */
export async function organisationMoneyBlocker(tx: Prisma.TransactionClient, organisationId: string, now: Date): Promise<string | null> {
  // Tickets people paid for, for something still to come: cancelling refunds them.
  const paidUpcoming = await tx.order.count({
    where: {
      organisationId,
      totalMinor: { gt: 0 },
      status: { in: [OrderStatus.CONFIRMED, OrderStatus.PENDING, OrderStatus.REQUESTED] },
      OR: [{ event: { endDateTime: { gt: now }, status: { not: EventStatus.CANCELLED } } }, { series: { status: { not: EventStatus.CANCELLED }, instances: { some: { endDateTime: { gt: now }, cancelledAt: null } } } }],
    },
  });
  if (paidUpcoming > 0) return "People have paid for upcoming events. Cancel those events (or their dates) first, which refunds them.";
  // Online payments still open: a buyer may be paying right now.
  if (await tx.payment.count({ where: { organisationId, status: PaymentStatus.PENDING, provider: { not: "OFFLINE" } } }) > 0) {
    return "Some buyers are still in the middle of paying. Try again once their payment pages have closed (within the hour).";
  }
  // Refunds on their way, whatever the event or order: deleting would lose them.
  if (await tx.paymentRefund.count({ where: { status: PaymentRefundStatus.PENDING, payment: { organisationId } } }) > 0) {
    return "Refunds are still on their way to buyers. Try again once they have gone through.";
  }
  // Refunds the provider refused, not retried, on payments with money still owed back.
  const failed = await tx.paymentRefund.findMany({
    where: { status: PaymentRefundStatus.FAILED, offline: false, retry: null, payment: { organisationId } },
    select: { payment: { select: { amountMinor: true, refunds: { where: { status: { in: COMMITTED } }, select: { amountMinor: true } } } } },
  });
  const owed = failed.some(({ payment }) => payment.amountMinor > payment.refunds.reduce((sum, refund) => sum + refund.amountMinor, BigInt(0)));
  if (owed) return "Some refunds failed and are still owed to buyers. Retry them from Failed refunds (the event's Finance tab or the series page) first.";
  // The cancellation itself is durable, even before refund processing starts
  // or when checked-in tickets prevent automatic cancellation. No time cutoff:
  // an unresolved cancellation remains owed after the event has ended.
  const cancelled = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT o."id" FROM "Order" o WHERE o."organisationId" = ${organisationId}
      AND ${cancelledTargetSql} AND ${refundableBalanceSql} > 0 LIMIT 1`;
  if (cancelled.length) return "Cancelled events or dates still have money to refund. Use Finish refunds in the event's Settings or beside the cancelled date on the series page. Use Refundable orders for checked-in guests once automatic cancellation refunds are finished.";
  return null;
}
