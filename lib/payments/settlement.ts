import "server-only";

import { CheckoutAttemptStatus, OrderStatus, PaymentStatus, RsvpStatus, type Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import { enqueueRsvpConfirmation } from "@/lib/outbox";
import { enqueueOrderEmail, enqueuePaymentEmail, organisationOwnerEmails } from "./email";
import { fenceOrganisation, hasFreeSeats, lockOrderTargets, ORDER_SUBJECT_SELECT, orderSubject, orderTargetCancelled, ticketTypesFit } from "./targets";
import { promoStillFits } from "./promo";
import { addOnsFit } from "./addOnStock";
import type { OnlineProvider } from "./http";
import type { PaidNotification } from "./providers/types";
import { createPendingRefund } from "./refunds";
import { formatMoney } from "./money";
import { notifyChat } from "@/lib/chat/notify";
import { noticeOrganisersOfRequest } from "@/lib/notices";
import type { WebhookEmission } from "@/lib/webhooks/emit";
import { placePaidTeamOrder, releaseUnpaidTeam } from "./teamOrders";
import { settleEntryFeePayment } from "./entryFees";

export type SettlementResult = {
  outcome: "confirmed" | "refunding" | "duplicate" | "already-settled" | "mismatch" | "unmatched";
  /** Refunds to submit to the provider after the transaction commits. */
  refundIds: string[];
  /** Organisation webhooks to emit after the transaction commits. */
  webhooks?: WebhookEmission[];
};

/** The status changes of registrations a payment confirmed, as organisation webhooks. */
export function heldStatusWebhooks(rsvpIds: string[], status: RsvpStatus): WebhookEmission[] {
  return rsvpIds.map((rsvpId) => ({ type: "registration.status_changed", rsvpId, status, previousStatus: RsvpStatus.PENDING_PAYMENT }));
}

const SETTLED: PaymentStatus[] = [PaymentStatus.PAID_ONLINE, PaymentStatus.PAID_OFFLINE, PaymentStatus.WAIVED];
const ID = /^[a-z0-9]{20,40}$/;

/** The payment a provider notification is about: by our attempt or the provider's ids, within one organisation and provider. */
async function findPayment(tx: Prisma.TransactionClient, context: { organisationId: string; provider: OnlineProvider; }, paid: PaidNotification) {
  const scope = { organisationId: context.organisationId, provider: context.provider };
  const byPayment = await tx.payment.findFirst({ where: { ...scope, externalPaymentId: paid.paymentId }, select: { id: true } });
  if (byPayment) return { paymentId: byPayment.id, attemptId: null };
  const attempt = await tx.paymentCheckoutAttempt.findFirst({
    where: {
      provider: context.provider,
      payment: { organisationId: context.organisationId },
      OR: [
        ...(paid.checkoutId ? [{ externalId: paid.checkoutId }] : []),
        ...(paid.reference && ID.test(paid.reference) ? [{ id: paid.reference }] : []),
      ],
    },
    select: { id: true, paymentId: true },
  });
  return attempt ? { paymentId: attempt.paymentId, attemptId: attempt.id } : null;
}

/**
 * Settle a captured payment the provider reported (webhook, return-page
 * check, or a hold expiry that found the page already paid).
 *
 * - A pending order whose seats are still held, or free again, becomes
 *   CONFIRMED with its payment PAID_ONLINE and every ticket CONFIRMED.
 * - A payment that arrives after the seats were released and taken is
 *   recorded as paid and refunded in full automatically.
 * - A second capture for an already-paid order is recorded as its own
 *   payment and refunded in full.
 * - A payment for a cancelled event, series or date is recorded, its order
 *   cancelled without tickets, and refunded in full automatically.
 *
 * Lock order matches registration: the organisation fence, the event row,
 * the order, then the payment. `now` stamps the payment; whether the hold is
 * still live, and so whether places must be counted again, is decided with
 * the time read once those locks are held, so a reservation that already
 * counted an ended hold's places as free is never oversold.
 */
export async function settlePaidNotification(
  tx: Prisma.TransactionClient,
  context: { organisationId: string; provider: OnlineProvider; },
  paid: PaidNotification,
  now = new Date(),
): Promise<SettlementResult> {
  if (paid.checkoutId == null && paid.reference == null) {
    // Only a provider payment id: settled already, or not ours.
    const known = await tx.payment.findFirst({ where: { organisationId: context.organisationId, provider: context.provider, externalPaymentId: paid.paymentId }, select: { id: true } });
    return { outcome: known ? "already-settled" : "unmatched", refundIds: [] };
  }
  const found = await findPayment(tx, context, paid);
  if (!found) return { outcome: "unmatched", refundIds: [] };
  const located = await tx.payment.findUniqueOrThrow({ where: { id: found.paymentId }, select: { externalPaymentId: true, orderId: true, order: { select: { id: true, eventId: true, eventSeriesId: true } } } });
  if (located.externalPaymentId === paid.paymentId) return { outcome: "already-settled", refundIds: [] };

  if (!(await fenceOrganisation(tx, context.organisationId))) return { outcome: "unmatched", refundIds: [] };
  await lockOrderTargets(tx, located.order, now);
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${located.orderId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${found.paymentId} FOR UPDATE`;
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: found.paymentId },
    select: {
      id: true, organisationId: true, status: true, amountMinor: true, currency: true, testMode: true, description: true, externalPaymentId: true,
      order: {
        select: {
          id: true, status: true, holdExpiresAt: true, buyerEmail: true, buyerName: true, eventId: true, teamId: true, teamName: true, teamJoin: true, submissionId: true, promoCodeId: true, ...ORDER_SUBJECT_SELECT,
          rsvps: { select: { id: true, orderId: true, eventId: true, eventInstanceId: true, ticketTypeId: true, status: true, holdExpiresAt: true, checkInToken: true, guestEmail: true, user: { select: { email: true } } } },
        },
      },
    },
  });
  if (payment.externalPaymentId === paid.paymentId) return { outcome: "already-settled", refundIds: [] };
  if (found.attemptId) await tx.paymentCheckoutAttempt.updateMany({ where: { id: found.attemptId, status: { not: CheckoutAttemptStatus.PAID } }, data: { status: CheckoutAttemptStatus.PAID } });

  // Hosted checkout fixes the amount; a different one is never settled.
  if ((paid.amountMinor != null && paid.amountMinor !== payment.amountMinor) || (paid.currency && paid.currency !== payment.currency)) {
    await recordAuditEvent({ action: "PAYMENT_AMOUNT_MISMATCH", organisationId: payment.organisationId, targetType: "Payment", targetId: payment.id, client: tx });
    return { outcome: "mismatch", refundIds: [] };
  }

  const order = payment.order;
  if (SETTLED.includes(payment.status)) {
    const duplicate = await tx.payment.create({
      data: {
        organisationId: payment.organisationId, orderId: order.id, amountMinor: payment.amountMinor, currency: payment.currency, status: PaymentStatus.PAID_ONLINE,
        provider: context.provider, externalPaymentId: paid.paymentId, testMode: payment.testMode, description: `Duplicate payment: ${payment.description}`.slice(0, 300), paidAt: now,
      },
      select: { id: true },
    });
    const refund = await createPendingRefund(tx, { paymentId: duplicate.id, amountMinor: payment.amountMinor, reason: "Duplicate payment for an order that was already paid", automatic: true });
    await recordAuditEvent({ action: "PAYMENT_DUPLICATE_REFUNDED", organisationId: payment.organisationId, targetType: "Payment", targetId: duplicate.id, client: tx });
    return { outcome: "duplicate", refundIds: [refund.id] };
  }

  // Cancelled meanwhile (a pass reaches its dates through its registrations):
  // refunded before any team place or project is confirmed.
  if (await orderTargetCancelled(tx, order)) return refundCancelledCapture(tx, payment, order, paid.paymentId, now);

  // A project entry fee (docs/HACKATHON.md) holds no places: it is always accepted.
  if (order.submissionId && order.rsvps.length === 0) {
    const refundId = await settleEntryFeePayment(tx, payment, { id: order.id, submissionId: order.submissionId, buyerEmail: order.buyerEmail, buyerName: order.buyerName }, paid, now);
    return refundId ? { outcome: "duplicate", refundIds: [refundId] } : { outcome: "confirmed", refundIds: [] };
  }

  const held = order.rsvps.filter((rsvp) => rsvp.status === RsvpStatus.PENDING_PAYMENT);
  // Read under the locks: a timestamp from before them may predate the hold's end.
  const at = new Date();
  const holdActive = order.status === OrderStatus.PENDING && Boolean(order.holdExpiresAt && order.holdExpiresAt > at);
  // After the hold ended, its extras, its ticket types' places and its promo
  // code's use were released too: taken back only if still there, checked
  // before anything (a team place) changes.
  const stocked = holdActive || (await addOnsFit(tx, order.id, at) && await ticketTypesFit(tx, held, at) && await promoStillFits(tx, order, at));
  // TEAM events place the one registration in its team or unit (docs/TEAMS.md).
  const team = stocked && held.length === 1 ? await placePaidTeamOrder(tx, order, held[0]!.id, holdActive, at) : null;
  const seats = stocked && (team ? team !== "gone" : held.length > 0 && (holdActive || await hasFreeSeats(tx, held, at)));
  const placed = team && team !== "gone" ? team : null;
  const status = placed?.status ?? RsvpStatus.CONFIRMED;
  await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.PAID_ONLINE, externalPaymentId: paid.paymentId, paidAt: now } });

  if (seats) {
    await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED, holdExpiresAt: null, holdCapAt: null } });
    await tx.rSVP.updateMany({ where: { id: { in: held.map((rsvp) => rsvp.id) } }, data: { status, holdExpiresAt: null } });
    await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: payment.id, notice: "paid" });
    if (status === RsvpStatus.PENDING_APPROVAL && order.eventId) await noticeOrganisersOfRequest(tx, { eventId: order.eventId });
    await notifyChat(tx, payment.organisationId, "payment", `Payment received: ${formatMoney(payment.amountMinor, payment.currency)} for ${payment.description}, ${held.length} ${held.length === 1 ? "ticket" : "tickets"}${payment.testMode ? " (test)" : ""}.`);
    // Each attendee with an address gets their own ticket, once (a pass's
    // ticket page lists its other dates).
    const emailed = new Set<string>();
    for (const rsvp of held) {
      const to = rsvp.user?.email?.trim() || rsvp.guestEmail;
      if (!to || emailed.has(to)) continue;
      emailed.add(to);
      await enqueueRsvpConfirmation(tx, { to, eventTitle: orderSubject(order)?.title ?? payment.description, status, checkInToken: rsvp.checkInToken, ...(placed?.teamName ? { teamName: placed.teamName } : {}) });
    }
    if (held.some((rsvp) => !(rsvp.user?.email || rsvp.guestEmail))) await enqueueOrderEmail(tx, { to: order.buyerEmail, orderId: order.id, notice: "attendee-details" });
    await recordAuditEvent({ action: "PAYMENT_SETTLED", organisationId: payment.organisationId, targetType: "Payment", targetId: payment.id, metadata: { testMode: payment.testMode, tickets: held.length }, client: tx });
    return { outcome: "confirmed", refundIds: [], webhooks: heldStatusWebhooks(held.map((rsvp) => rsvp.id), status) };
  }

  // The seats were released and taken: keep the money's record, return it all.
  if (order.status === OrderStatus.PENDING) await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.EXPIRED, holdExpiresAt: null, holdCapAt: null } });
  // A leader's team that was never placed goes too, freeing its name.
  await releaseUnpaidTeam(tx, order.id);
  const refund = await createPendingRefund(tx, { paymentId: payment.id, amountMinor: payment.amountMinor, reason: "Paid after the hold ended and the places were gone", automatic: true });
  await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: payment.id, notice: "late-refund" });
  for (const owner of await organisationOwnerEmails(tx, payment.organisationId)) {
    await enqueuePaymentEmail(tx, { to: owner, paymentId: payment.id, notice: "organiser-late-refund" });
  }
  await recordAuditEvent({ action: "PAYMENT_LATE_REFUNDED", organisationId: payment.organisationId, targetType: "Payment", targetId: payment.id, client: tx });
  return { outcome: "refunding", refundIds: [refund.id] };
}

/**
 * A payment captured for a cancelled event, series or date (the payment, order
 * and target locks are held): recorded as paid, the order cancelled with its
 * held places, and the whole amount refunded. The buyer is told the refund is
 * on its way (it is still pending at the provider) and the organisers' chat
 * hears it.
 */
async function refundCancelledCapture(
  tx: Prisma.TransactionClient,
  payment: { id: string; organisationId: string; amountMinor: bigint; currency: string; description: string; testMode: boolean; },
  order: { id: string; buyerEmail: string; },
  externalPaymentId: string,
  now: Date,
): Promise<SettlementResult> {
  await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.PAID_ONLINE, externalPaymentId, paidAt: now } });
  await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED, holdExpiresAt: null, holdCapAt: null } });
  // A leader's unpaid team goes first, then the held places: no ticket is issued.
  await releaseUnpaidTeam(tx, order.id);
  await tx.rSVP.deleteMany({ where: { orderId: order.id, status: RsvpStatus.PENDING_PAYMENT } });
  const refund = await createPendingRefund(tx, { paymentId: payment.id, amountMinor: payment.amountMinor, reason: "Paid after the event was cancelled", automatic: true });
  await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: payment.id, notice: "cancelled-refund" });
  await notifyChat(tx, payment.organisationId, "refund", `A payment of ${formatMoney(payment.amountMinor, payment.currency)} for ${payment.description} arrived after it was cancelled, so no ticket was issued and it is being refunded in full${payment.testMode ? " (test)" : ""}.`);
  await recordAuditEvent({ action: "PAYMENT_CANCELLED_EVENT_REFUNDED", organisationId: payment.organisationId, targetType: "Payment", targetId: payment.id, client: tx });
  return { outcome: "refunding", refundIds: [refund.id] };
}
