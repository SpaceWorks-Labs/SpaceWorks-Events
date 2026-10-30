import "server-only";

import { OrderStatus, Prisma, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { noticeEach, noticeSubject, personEmail, uniqueEmails } from "@/lib/notices";
import { PaymentOperationError, refundOrder } from "./operations";
import { refundableBalanceSql } from "./refundableBalance";

/**
 * An event was cancelled: every paid order is refunded in full and its
 * tickets cancelled (the buyer is emailed), orders still being paid for are
 * released, and requests are declined. Run after the cancellation is saved;
 * a retry only finds orders not yet handled, so nothing is refunded twice.
 * An order someone already checked in on is left for the organiser.
 */
export async function refundCancelledEvent(params: { eventId: string; organisationId: string; actorUserId: string; now?: Date; }) {
  const now = params.now ?? new Date();
  const orders = await prisma.order.findMany({
    // Free orders need no refund: their guests are told the event is off.
    where: { eventId: params.eventId, organisationId: params.organisationId, totalMinor: { gt: 0 }, status: { in: [OrderStatus.CONFIRMED, OrderStatus.PENDING, OrderStatus.REQUESTED] } },
    select: { id: true, status: true },
  });
  let refunded = 0;
  let failed = 0;
  for (const order of orders) {
    try {
      if (order.status === OrderStatus.CONFIRMED) {
        await refundOrder({ orderId: order.id, organisationId: params.organisationId, actorUserId: params.actorUserId, amountMinor: null, reason: "Event cancelled", cancelTickets: true, now });
        refunded += 1;
      } else if (order.status === OrderStatus.PENDING) {
        // Ending the hold lets the scheduler close the payment page, then release the order.
        await prisma.$transaction([
          prisma.order.updateMany({ where: { id: order.id, status: OrderStatus.PENDING }, data: { holdExpiresAt: now } }),
          prisma.rSVP.updateMany({ where: { orderId: order.id, status: RsvpStatus.PENDING_PAYMENT }, data: { holdExpiresAt: now } }),
        ]);
      } else {
        await prisma.$transaction([
          prisma.order.updateMany({ where: { id: order.id, status: OrderStatus.REQUESTED }, data: { status: OrderStatus.CANCELLED } }),
          prisma.rSVP.deleteMany({ where: { orderId: order.id } }),
        ]);
      }
    } catch (error) {
      if (!(error instanceof PaymentOperationError)) throw error;
      failed += 1;
    }
  }
  await recordAuditEvent({ action: "EVENT_CANCELLED_REFUNDS", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Event", targetId: params.eventId, metadata: { orders: orders.length, refunded, failed } });
  return { refunded, failed };
}

/** Everyone with a place, a request or a waitlist spot (and buyers still paying or waiting to hear) on an event or date. */
export async function peopleWithPlaces(tx: Prisma.TransactionClient, target: { eventId: string; } | { eventInstanceId: string; }) {
  const [rsvps, orders] = await Promise.all([
    tx.rSVP.findMany({
      where: { ...target, status: { in: [RsvpStatus.CONFIRMED, RsvpStatus.PENDING_PAYMENT, RsvpStatus.WAITLISTED, RsvpStatus.PENDING_APPROVAL] } },
      select: { guestEmail: true, user: { select: { email: true } } },
    }),
    tx.order.findMany({ where: { ...target, status: { in: [OrderStatus.PENDING, OrderStatus.REQUESTED] } }, select: { buyerEmail: true } }),
  ]);
  return uniqueEmails([...rsvps.map(personEmail), ...orders.map((order) => order.buyerEmail)]);
}

/** Tell everyone on an event that it was cancelled. Run in the transaction that cancels it, before anything is removed. */
export async function notifyEventCancelled(tx: Prisma.TransactionClient, params: { organisationId: string; eventId: string; title: string; reason?: string | null; }) {
  await notifyChat(tx, params.organisationId, "event", `${params.title} was cancelled. Everyone with a place is being told, and buyers refunded.`);
  return noticeEach(tx, await peopleWithPlaces(tx, { eventId: params.eventId }), {
    organisationId: params.organisationId,
    subject: noticeSubject("Cancelled", params.title),
    lines: [
      `${params.title} has been cancelled by the organiser.`,
      ...(params.reason?.trim() ? [params.reason.trim()] : []),
      "If you paid, you'll get a separate email about your refund: card and UPI refunds can take 5 to 10 working days to appear. Nothing more will be charged.",
    ],
  });
}

/**
 * Keep the organiser's ledger reachable while any money is held or in flight,
 * including legitimate retained revenue on dates that have already happened.
 * Deletion rechecks under target locks; only fully refunded paid orders can go.
 */
export async function hasPaidOrders(owner: { eventId: string; } | { eventSeriesId: string; }, client: Prisma.TransactionClient = prisma) {
  // Keep the target attached until its balance is resolved: deleting
  // it would otherwise orphan the order and remove its refund UI and blocker.
  const scope = "eventId" in owner ? Prisma.sql`o."eventId" = ${owner.eventId}` : Prisma.sql`o."eventSeriesId" = ${owner.eventSeriesId}`;
  const owed = await client.$queryRaw<Array<{ id: string }>>`SELECT o."id" FROM "Order" o
    WHERE ${scope} AND (
      (o."totalMinor" > 0 AND o."status" IN ('PENDING', 'REQUESTED'))
      OR ${refundableBalanceSql} > 0
      OR EXISTS (SELECT 1 FROM "Payment" p JOIN "PaymentRefund" r ON r."paymentId" = p."id"
        WHERE p."orderId" = o."id" AND (r."status" = 'PENDING'
          OR (r."status" = 'FAILED'
            AND NOT EXISTS (SELECT 1 FROM "PaymentRefund" retry WHERE retry."retryOfRefundId" = r."id")
            AND ${refundableBalanceSql} > 0)))
    ) LIMIT 1`;
  return owed.length > 0;
}

export const PAID_EVENT_REFUSAL = "This event still holds money or has payments or refunds to resolve. Keep it as a record if you are retaining revenue. To delete it, resolve unpaid orders, refund all collected money (including attended tickets), retry Failed refunds in Finance and wait for pending refunds to finish. Use the guest list for attended tickets and Refundable orders for cancelled orders.";
export const PAID_SERIES_REFUSAL = "This series still holds money or has payments or refunds to resolve, including payments for earlier dates. Keep it cancelled as a record if you are retaining revenue. To delete it, resolve unpaid orders, refund all collected money, retry Failed refunds on the series page and wait for pending refunds to finish. Use each date's guest list for attended tickets and Refundable orders for cancelled orders.";
