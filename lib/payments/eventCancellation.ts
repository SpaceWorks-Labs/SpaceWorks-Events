import "server-only";

import { OrderStatus, RsvpStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { noticeEach, noticeSubject, personEmail, uniqueEmails } from "@/lib/notices";
import { PaymentOperationError, refundOrder } from "./operations";

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
 * Whether people have paid for (or are paying for) this event or series, so
 * it must be cancelled rather than deleted. Deletion asks again inside its
 * transaction, under the locks reservations take.
 */
export async function hasPaidOrders(owner: { eventId: string; } | { eventSeriesId: string; }, client: Prisma.TransactionClient = prisma) {
  return (await client.order.count({ where: { ...owner, totalMinor: { gt: 0 }, status: { in: [OrderStatus.CONFIRMED, OrderStatus.PENDING, OrderStatus.REQUESTED] } } })) > 0;
}

export const PAID_EVENT_REFUSAL = "People have paid for this event. Cancel it instead, which refunds them in full.";
export const PAID_SERIES_REFUSAL = "People have paid for this series. Cancel its dates instead, which refunds them.";
