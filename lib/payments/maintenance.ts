import "server-only";

import { CheckoutAttemptStatus, EventStatus, OrderStatus, PaymentRefundStatus, PaymentStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { closeOpenAttempts } from "./checkout";
import { enqueuePaymentEmail } from "./email";
import { fillFromWaitlist } from "./operations";
import { lockOrderTargets, seatTargetOf } from "./targets";
import { submitPendingRefund } from "./refunds";
import { releaseUnpaidTeam } from "./teamOrders";

const BATCH = 25;
/** Refunds still pending at the provider are re-checked this long after submission. */
const REFUND_RETRY_AFTER_MS = 2 * 60_000;

/**
 * Release one order whose hold has ended. Every open provider page is
 * cancelled first; the seats are released only once all are closed, so they
 * are never resold while a page can still take money. If the buyer paid
 * first, the order is settled instead (and refunded if the seats are gone).
 */
async function releaseOrder(orderId: string, now: Date): Promise<"expired" | "settled" | "skipped"> {
  const pages = await closeOpenAttempts(orderId, now);
  if (pages === "open") return "skipped";
  if (pages === "settled") return "settled";

  return prisma.$transaction(async (tx) => {
    const row = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, eventId: true, eventSeriesId: true } });
    if (row) await lockOrderTargets(tx, row, now);
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, organisationId: true, status: true, holdExpiresAt: true, buyerEmail: true, payments: { where: { status: PaymentStatus.PENDING }, select: { id: true } },
        event: { select: { status: true } }, series: { select: { status: true } }, instance: { select: { cancelledAt: true } },
      },
    });
    // Extended or settled meanwhile.
    if (order?.status !== OrderStatus.PENDING || (order.holdExpiresAt && order.holdExpiresAt > now)) return "skipped" as const;
    await tx.paymentCheckoutAttempt.updateMany({ where: { status: CheckoutAttemptStatus.OPEN, payment: { orderId } }, data: { status: CheckoutAttemptStatus.EXPIRED } });
    await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.EXPIRED, holdExpiresAt: null, holdCapAt: null } });
    // A team whose leader never paid goes, freeing its name (docs/TEAMS.md).
    await releaseUnpaidTeam(tx, orderId);
    // The registrations stay as ended holds (no longer counted toward
    // capacity); ordering again replaces them.
    // A cancelled event's buyers were already told why; "time ran out" would be wrong.
    const cancelled = order.event?.status === EventStatus.CANCELLED || order.series?.status === EventStatus.CANCELLED || Boolean(order.instance?.cancelledAt);
    for (const payment of order.payments) {
      await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.EXPIRED } });
      if (!cancelled) await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: payment.id, notice: "expired" });
    }
    await recordAuditEvent({ action: "ORDER_HOLD_EXPIRED", organisationId: order.organisationId, targetType: "Order", targetId: orderId, client: tx });
    return "expired" as const;
  });
}

/** How long before a long hold ends its one reminder goes out. */
const REMINDER_BEFORE_MS = 3 * 60 * 60_000;
/** Only holds placed this long ago are long ones (a payment link's day, not checkout's half hour). */
const LONG_HOLD_MS = 6 * 60 * 60_000;

/**
 * Remind each buyer once, a few hours before a day-long payment link runs
 * out (after approval, a waitlist place, or a link the organiser sent).
 * Claiming the order first means a reminder is never sent twice.
 */
async function sendPaymentReminders(now: Date) {
  const due = await prisma.order.findMany({
    where: {
      status: OrderStatus.PENDING, paymentReminderSentAt: null,
      holdExpiresAt: { gt: now, lte: new Date(now.getTime() + REMINDER_BEFORE_MS) },
      createdAt: { lte: new Date(now.getTime() - LONG_HOLD_MS) },
    },
    select: { id: true, buyerEmail: true, payments: { where: { status: PaymentStatus.PENDING }, select: { id: true } } },
    take: BATCH,
  });
  let sent = 0;
  for (const order of due) {
    const payment = order.payments[0];
    if (!payment) continue;
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({ where: { id: order.id, paymentReminderSentAt: null }, data: { paymentReminderSentAt: now } });
      if (claimed.count === 1) {
        await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: payment.id, notice: "reminder" });
        sent += 1;
      }
    });
  }
  return sent;
}

/**
 * One pass of payment housekeeping, run by the one-minute outbox scheduler:
 * release ended holds, and submit or re-check refunds left pending.
 */
export async function runPaymentMaintenance(now = new Date()) {
  let expired = 0;
  let settled = 0;
  const stale = await prisma.order.findMany({
    where: { status: OrderStatus.PENDING, holdExpiresAt: { lte: now } },
    select: { id: true },
    orderBy: { holdExpiresAt: "asc" },
    take: BATCH,
  });
  for (const { id } of stale) {
    const result = await releaseOrder(id, now).catch(() => "skipped" as const);
    if (result === "expired") {
      expired += 1;
      // The released seats go to whoever is next on the waitlist.
      const seats = await prisma.rSVP.findMany({ where: { orderId: id }, select: { eventId: true, eventInstanceId: true }, distinct: ["eventId", "eventInstanceId"] });
      for (const seat of seats) {
        const target = seatTargetOf(seat);
        if (target) await fillFromWaitlist(target, now);
      }
    }
    if (result === "settled") settled += 1;
  }
  const reminded = await sendPaymentReminders(now);
  const refunds = await prisma.paymentRefund.findMany({
    where: {
      status: PaymentRefundStatus.PENDING,
      offline: false,
      externalRefundId: null,
      OR: [{ submittedAt: null }, { submittedAt: { lt: new Date(now.getTime() - REFUND_RETRY_AFTER_MS) } }],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });
  let refundsSubmitted = 0;
  for (const { id } of refunds) {
    if ((await submitPendingRefund(id).catch(() => "skipped" as const)) === "submitted") refundsSubmitted += 1;
  }
  return { expired, settled, refundsSubmitted, reminded };
}
