import "server-only";

import { OrderStatus, PaymentRefundStatus, PaymentStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { emitWebhookEvent, type WebhookEmission } from "@/lib/webhooks/emit";
import { enqueueOrderEmail, enqueuePaymentEmail } from "../email";
import { formatMoney } from "../money";
import { asRefundPolicy, policyRefundMinor } from "../refundPolicy";
import { createPendingRefund, submitPendingRefund } from "../refunds";
import { seatTargetOf } from "../targets";
import { lockOrderRegistrations, releaseTeamPlacesForCancelledOrder, type CancelledRegistration } from "../teamOrders";
import { ANSWER_CHANGED, lockCurrentNo, type AttendanceNo } from "@/lib/attendanceGuard";
import { COLLECTED, COMMITTED_REFUND, lockOrder, PaymentOperationError, ZERO } from "./shared";
import { fillFromWaitlist } from "./waitlist";

type CollectedPayment = { id: string; status: PaymentStatus; amountMinor: bigint; };

/** What is still refundable on each collected payment of an order. */
function refundable(payments: Array<{ id: string; amountMinor: bigint; refunds: Array<{ amountMinor: bigint; status: PaymentRefundStatus; }>; }>) {
  return payments.map((payment) => ({
    id: payment.id,
    remaining: payment.amountMinor - payment.refunds.filter((refund) => COMMITTED_REFUND.includes(refund.status)).reduce((sum, refund) => sum + refund.amountMinor, ZERO),
  }));
}

/**
 * Lock an order's collected payments and record refunds of `wanted` (null:
 * everything left, or `share` of it) across them, oldest first. Money paid in
 * person is recorded as returned in person; online refunds are PENDING rows
 * sent to the provider after commit. The caller holds the order lock.
 */
export async function recordRefundsTx(tx: Prisma.TransactionClient, payments: CollectedPayment[], params: { wanted: bigint | null; share?: { of: number; over: number; }; currency: string; reason: string; actorUserId: string | null; now: Date; }) {
  for (const payment of payments) await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${payment.id} FOR UPDATE`;
  const refunds = await tx.paymentRefund.findMany({ where: { paymentId: { in: payments.map((payment) => payment.id) } }, select: { paymentId: true, amountMinor: true, status: true } });
  const balances = refundable(payments.map((payment) => ({ ...payment, refunds: refunds.filter((refund) => refund.paymentId === payment.id) })));
  const available = balances.reduce((sum, balance) => sum + balance.remaining, ZERO);
  const wanted = params.wanted ?? (params.share ? (available * BigInt(params.share.of)) / BigInt(params.share.over) : available);
  if (wanted < ZERO || wanted > available) throw new PaymentOperationError(`You can refund up to ${formatMoney(available, params.currency)} on this order.`);
  const onlineRefundIds: string[] = [];
  let left = wanted;
  let refundedPaymentId: string | null = null;
  for (const balance of balances) {
    if (left === ZERO) break;
    const amount = balance.remaining < left ? balance.remaining : left;
    if (amount === ZERO) continue;
    left -= amount;
    refundedPaymentId ??= balance.id;
    const payment = payments.find((candidate) => candidate.id === balance.id)!;
    // Paid in person (even on an order that started online): returned in person, and recorded.
    if (payment.status === PaymentStatus.PAID_OFFLINE) {
      await tx.paymentRefund.create({ data: { paymentId: payment.id, amountMinor: amount, offline: true, status: PaymentRefundStatus.SUCCEEDED, settledAt: params.now, reason: params.reason.slice(0, 500), createdByUserId: params.actorUserId } });
    } else {
      onlineRefundIds.push((await createPendingRefund(tx, { paymentId: payment.id, amountMinor: amount, reason: params.reason, createdByUserId: params.actorUserId })).id);
    }
  }
  return { wanted, onlineRefundIds, refundedPaymentId };
}

export const ORDER_FOR_REFUND = {
  id: true, status: true, buyerEmail: true, currency: true, eventId: true, teamId: true, teamName: true, teamJoin: true,
  rsvps: { select: { id: true, checkedInAt: true, eventId: true, eventInstanceId: true, userId: true, guestName: true, createdAt: true, status: true } },
  payments: { where: { status: { in: COLLECTED } }, orderBy: { paidAt: "asc" }, select: { id: true, status: true, amountMinor: true } },
} satisfies Prisma.OrderSelect;

const cancelledWebhook = (rsvp: CancelledRegistration): WebhookEmission => ({
  type: "registration.status_changed", rsvpId: rsvp.id, status: "CANCELLED", previousStatus: rsvp.status,
  snapshot: { id: rsvp.id, eventId: rsvp.eventId, eventInstanceId: rsvp.eventInstanceId, userId: rsvp.userId, guestName: rsvp.guestName, createdAt: rsvp.createdAt, checkedInAt: rsvp.checkedInAt },
});

/**
 * Refund an order, in full or in part, optionally cancelling its tickets
 * (which frees the seats for the waitlist). Online refunds are recorded
 * under the lock and sent to the provider after commit; money returned by
 * hand for an offline payment is recorded as already settled. On a TEAM
 * event, cancelling also takes its registration out of its team, or the
 * whole team with a PER_TEAM leader's order (docs/TEAMS.md).
 */
export async function refundOrder(params: {
  orderId: string;
  organisationId: string;
  actorUserId: string | null;
  /** Null refunds everything still refundable. */
  amountMinor: bigint | null;
  reason: string;
  cancelTickets: boolean;
  now?: Date;
  /** An attendance "No" cancelling the order: only while that answer is still current. */
  attendanceNo?: AttendanceNo;
}) {
  const now = params.now ?? new Date();
  const webhooks: WebhookEmission[] = [];
  const outcome = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, params.orderId);
    const head = await tx.order.findFirst({ where: { id: params.orderId, organisationId: params.organisationId }, select: { id: true, eventId: true, teamId: true, teamName: true } });
    if (!head) throw new PaymentOperationError("Only confirmed orders can be refunded or cancelled.");
    // Then its payments, then its registrations by id (docs/PAYMENTS.md), before
    // any check-in is read: a scan waits for this, or is seen below.
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "orderId" = ${head.id} ORDER BY "id" FOR UPDATE`;
    await lockOrderRegistrations(tx, head);
    if (params.attendanceNo && !(await lockCurrentNo(tx, params.attendanceNo))) throw new PaymentOperationError(ANSWER_CHANGED);
    const order = await tx.order.findFirst({ where: { id: head.id }, select: ORDER_FOR_REFUND });
    if (!order || order.status !== OrderStatus.CONFIRMED) throw new PaymentOperationError("Only confirmed orders can be refunded or cancelled.");
    if (params.amountMinor === ZERO && !params.cancelTickets) throw new PaymentOperationError("Enter an amount to refund.");
    if (params.cancelTickets && order.rsvps.some((rsvp) => rsvp.checkedInAt)) throw new PaymentOperationError("Someone on this order has checked in, so its tickets can't be cancelled.");
    const { wanted, onlineRefundIds, refundedPaymentId } = await recordRefundsTx(tx, order.payments, { wanted: params.amountMinor, currency: order.currency, reason: params.reason, actorUserId: params.actorUserId, now });
    if (wanted === ZERO && !params.cancelTickets) throw new PaymentOperationError("Enter an amount to refund.");
    if (params.cancelTickets) {
      const teamRemoved = await releaseTeamPlacesForCancelledOrder(tx, order);
      if ("error" in teamRemoved) throw new PaymentOperationError(teamRemoved.error);
      await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
      // A reservation to be paid at the desk is no longer owed.
      await tx.payment.updateMany({ where: { orderId: order.id, status: PaymentStatus.PENDING }, data: { status: PaymentStatus.CANCELED } });
      // The order, its lines, payments and refunds keep the record. Nothing
      // checked in is ever deleted: a mismatch rolls the whole cancellation back.
      const deleted = await tx.rSVP.deleteMany({ where: { orderId: order.id, checkedInAt: null } });
      if (deleted.count !== order.rsvps.length) throw new Error("The order changed while it was being cancelled.");
      webhooks.push(...[...order.rsvps, ...teamRemoved].map(cancelledWebhook));
    }
    if (refundedPaymentId) await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: refundedPaymentId, notice: "refunded" });
    // Complimentary, unpaid or nothing left to refund: still tell the buyer.
    else if (params.cancelTickets) await enqueueOrderEmail(tx, { to: order.buyerEmail, orderId: order.id, notice: "cancelled" });
    if (wanted > ZERO || params.cancelTickets) {
      await notifyChat(tx, params.organisationId, "refund", `${wanted > ZERO ? `Refund of ${formatMoney(wanted, order.currency)}` : "Tickets cancelled"} for ${order.buyerEmail}${params.cancelTickets ? ", tickets cancelled" : ""}. Reason: ${params.reason.slice(0, 200)}`);
    }
    await recordAuditEvent({
      action: params.cancelTickets ? "ORDER_CANCELLED" : "PAYMENT_REFUNDED",
      actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Order", targetId: order.id,
      metadata: { amountMinor: wanted.toString(), cancelled: params.cancelTickets }, client: tx,
    });
    const freed = params.cancelTickets ? [...new Map(order.rsvps.flatMap((rsvp) => { const target = seatTargetOf(rsvp); return target ? [[JSON.stringify(target), target] as const] : []; })).values()] : [];
    return { onlineRefundIds, freed, refundedMinor: wanted };
  });
  await submitRefunds(outcome.onlineRefundIds);
  for (const webhook of webhooks) emitWebhookEvent(webhook);
  for (const target of outcome.freed) await fillFromWaitlist(target, now);
  return { refundedMinor: outcome.refundedMinor };
}

/**
 * Refund everything still refundable on a confirmed order inside the
 * caller's transaction, which already holds the event lock: a rejected team
 * or a disqualified project. Registrations are left alone. Returns the
 * refunds to submit to the provider after commit (submitRefunds).
 */
export async function refundWholeOrderTx(tx: Prisma.TransactionClient, params: { orderId: string; reason: string; actorUserId: string | null; now?: Date; }): Promise<string[]> {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${params.orderId} FOR UPDATE`;
  const order = await tx.order.findUnique({ where: { id: params.orderId }, select: { id: true, organisationId: true, status: true, buyerEmail: true, currency: true, payments: ORDER_FOR_REFUND.payments } });
  if (!order || order.status !== OrderStatus.CONFIRMED || order.payments.length === 0) return [];
  const { wanted, onlineRefundIds, refundedPaymentId } = await recordRefundsTx(tx, order.payments, { wanted: null, currency: order.currency, reason: params.reason, actorUserId: params.actorUserId, now: params.now ?? new Date() });
  if (wanted === ZERO) return [];
  if (refundedPaymentId) await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: refundedPaymentId, notice: "refunded" });
  await notifyChat(tx, order.organisationId, "refund", `Refund of ${formatMoney(wanted, order.currency)} for ${order.buyerEmail}. Reason: ${params.reason.slice(0, 200)}`);
  await recordAuditEvent({ action: "PAYMENT_REFUNDED", actorUserId: params.actorUserId, organisationId: order.organisationId, targetType: "Order", targetId: order.id, metadata: { amountMinor: wanted.toString(), cancelled: false, automatic: true }, client: tx });
  return onlineRefundIds;
}

/** Send refunds recorded inside a transaction to the provider, once it has committed. */
export async function submitRefunds(refundIds: string[]) {
  for (const refundId of refundIds) await submitPendingRefund(refundId).catch(() => undefined);
}


/** The buyer's view of cancelling: allowed, and what comes back. */
export async function buyerCancellation(orderId: string, now = new Date()) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      status: true, refundPolicy: true, event: { select: { startDateTime: true } },
      rsvps: { select: { checkedInAt: true, eventInstance: { select: { startDateTime: true } } } },
      payments: { where: { status: { in: COLLECTED } }, select: { id: true, amountMinor: true, refunds: { select: { amountMinor: true, status: true } } } },
    },
  });
  if (!order) return null;
  // A series order (a date, or a pass) starts at its first date.
  const firstDate = order.rsvps.map((rsvp) => rsvp.eventInstance?.startDateTime).filter((date): date is Date => Boolean(date)).sort((a, b) => a.getTime() - b.getTime())[0];
  const start = order.event?.startDateTime ?? firstDate;
  if (order.status !== OrderStatus.CONFIRMED || !start || order.rsvps.some((rsvp) => rsvp.checkedInAt)) return null;
  const available = refundable(order.payments).reduce((sum, balance) => sum + balance.remaining, ZERO);
  // Complimentary or free orders can always be given up.
  if (order.payments.length === 0) return { refundMinor: ZERO };
  const refundMinor = policyRefundMinor(asRefundPolicy(order.refundPolicy), available, start, now);
  return refundMinor == null ? null : { refundMinor };
}

/** The buyer cancels their whole order within its refund policy. */
export async function cancelOrderAsBuyer(params: { orderId: string; now?: Date; attendanceNo?: AttendanceNo; }) {
  const now = params.now ?? new Date();
  const order = await prisma.order.findUnique({ where: { id: params.orderId }, select: { organisationId: true, buyerUserId: true } });
  const terms = await buyerCancellation(params.orderId, now);
  if (!order || !terms) throw new PaymentOperationError("This order can't be cancelled online. Contact the organiser.");
  return refundOrder({
    orderId: params.orderId, organisationId: order.organisationId, actorUserId: order.buyerUserId,
    amountMinor: terms.refundMinor, reason: "Cancelled by the buyer under the refund policy", cancelTickets: true, now, attendanceNo: params.attendanceNo,
  });
}
