import "server-only";

import { OrderStatus, RegistrationMode, RsvpStatus, type Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import { enqueuePaymentEmail } from "@/lib/payments/email";
import { HOLD_EXTENSION_CAP_MS, PAYMENT_LINK_HOLD_MS } from "@/lib/payments/holds";
import { providerMinimumMinor } from "@/lib/payments/money";
import { offerInTransaction } from "@/lib/payments/operations/waitlist";
import { promoStillFits } from "@/lib/payments/promo";
import { ORDER_SUBJECT_SELECT, orderSubject } from "@/lib/payments/targets";
import { countConfirmedUnits } from "@/lib/teamUnits";
import { AdmissionError, setUnitStatus, ticketTypeHasRoom, unitOrder, type AdmissionEvent, type ApplicationRow } from "./state";

/*
 * Paying for an accepted offer (docs/ADMISSION.md "Paid places"). A place is
 * never confirmed unpaid: "Accept and pay" holds the place for a day while
 * the order is paid through the usual payment link (offerInTransaction for a
 * solo registration). On a TEAM event the leader pays once for the team
 * (PER_TEAM): the team holds its place through the leader's hold, and the
 * settled payment confirms every member (placePaidTeamOrder). When a hold ends
 * unpaid, the offer stands again until its respond-by time
 * (`reopenEndedHold`), after which it expires.
 */

type Account = { provider: "RAZORPAY" | "STRIPE"; testMode: boolean };

export async function holdPaidPlace(
  tx: Prisma.TransactionClient,
  params: { event: AdmissionEvent; app: ApplicationRow; account: Account; actorUserId: string | null; now: Date },
): Promise<void> {
  const { event, app, account, now } = params;
  const order = await unitOrder(tx, app);
  if (!order) throw new AdmissionError("This place has no order to pay.");
  if (order.status === OrderStatus.EXPIRED && (await reopenEndedHold(tx, app)) === "promo-used-up") throw new AdmissionError(PROMO_USED_UP);
  if (app.rsvpId) {
    // A solo applicant on a TEAM event takes one unit (teams count once), not one person against capacity.
    const hasRoom = event.registrationMode === RegistrationMode.TEAM
      ? async (rsvps: Array<{ ticketTypeId: string | null }>) => (event.capacity == null || (await countConfirmedUnits(tx, event.id, now)) < event.capacity)
        && (await Promise.all(rsvps.map((rsvp) => ticketTypeHasRoom(tx, rsvp.ticketTypeId, event.id, now)))).every(Boolean)
      : undefined;
    await offerInTransaction(tx, { orderId: order.id, organisationId: event.organisationId, provider: account.provider, testMode: account.testMode, actorUserId: params.actorUserId, now, hasRoom });
    return;
  }
  await holdTeamPlace(tx, { event, teamId: app.teamId!, orderId: order.id, account, actorUserId: params.actorUserId, now });
}

/** The PER_TEAM leader's order: hold one unit for the whole team while the leader pays. */
async function holdTeamPlace(
  tx: Prisma.TransactionClient,
  params: { event: AdmissionEvent; teamId: string; orderId: string; account: Account; actorUserId: string | null; now: Date },
) {
  const { event, account, now } = params;
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${params.orderId} FOR UPDATE`;
  const order = await tx.order.findFirst({
    where: { id: params.orderId, organisationId: event.organisationId },
    select: { id: true, status: true, totalMinor: true, currency: true, buyerEmail: true, ...ORDER_SUBJECT_SELECT },
  });
  if (!order || order.status !== OrderStatus.REQUESTED) throw new AdmissionError("This order was changed by someone else.");
  const subject = orderSubject(order);
  if (!subject || !subject.open(now)) throw new AdmissionError("This event is no longer open for registration.");
  if (order.totalMinor < providerMinimumMinor(account.provider, order.currency)) throw new AdmissionError("This order is below the smallest payment the provider accepts.");
  if (event.registrationMode === RegistrationMode.TEAM && event.capacity != null && (await countConfirmedUnits(tx, event.id, now)) >= event.capacity) {
    throw new AdmissionError("There are no free places right now. Try again later.");
  }
  // The leader's ticket type limit, as hasFreeSeats checks for a solo order.
  const leader = await tx.rSVP.findFirst({ where: { orderId: order.id, teamId: params.teamId }, select: { ticketTypeId: true } });
  if (!(await ticketTypeHasRoom(tx, leader?.ticketTypeId ?? null, event.id, now))) throw new AdmissionError("This ticket type has no free places right now. Try again later.");
  const holdExpiresAt = new Date(now.getTime() + PAYMENT_LINK_HOLD_MS);
  await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.PENDING, holdExpiresAt, holdCapAt: new Date(holdExpiresAt.getTime() + HOLD_EXTENSION_CAP_MS), testMode: account.testMode } });
  // The team holds its unit through the leader's hold (countConfirmedUnits); the members, who
  // have no order of their own, stay pending until the payment confirms them all.
  await tx.team.update({ where: { id: params.teamId }, data: { status: RsvpStatus.PENDING_PAYMENT } });
  await tx.rSVP.updateMany({ where: { orderId: order.id, teamId: params.teamId }, data: { status: RsvpStatus.PENDING_PAYMENT, holdExpiresAt } });
  const payment = await tx.payment.create({
    data: { organisationId: event.organisationId, orderId: order.id, amountMinor: order.totalMinor, currency: order.currency, provider: account.provider, testMode: account.testMode, description: subject.title.slice(0, 300) },
    select: { id: true },
  });
  await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: payment.id, notice: "pending" });
  await recordAuditEvent({ action: "ORDER_OFFERED", actorUserId: params.actorUserId, organisationId: event.organisationId, targetType: "Order", targetId: order.id, client: tx });
}

export const PROMO_USED_UP = "The promo code on this place has been used up since, so it can't be paid at that price. Ask the organiser.";

/**
 * A payment hold ended unpaid (the order is EXPIRED): put the order back to
 * REQUESTED and the registrations back to pending, so the offer can be
 * accepted (and paid) again while it lasts. A REQUESTED order counts as using
 * its promo code again, so a code used up meanwhile (checked under the Order
 * lock, at a time read there) leaves the order EXPIRED: "promo-used-up".
 * Null when nothing changed.
 */
export async function reopenEndedHold(tx: Prisma.TransactionClient, app: Pick<ApplicationRow, "rsvpId" | "teamId">): Promise<"reopened" | "promo-used-up" | null> {
  const order = await unitOrder(tx, app);
  if (!order || order.status !== OrderStatus.EXPIRED) return null;
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
  const locked = await tx.order.findUnique({ where: { id: order.id }, select: { id: true, status: true, promoCodeId: true } });
  if (locked?.status !== OrderStatus.EXPIRED) return null;
  if (!(await promoStillFits(tx, locked, new Date()))) return "promo-used-up";
  const reopened = await tx.order.updateMany({ where: { id: order.id, status: OrderStatus.EXPIRED }, data: { status: OrderStatus.REQUESTED, holdExpiresAt: null, holdCapAt: null, paymentReminderSentAt: null } });
  if (reopened.count !== 1) return null;
  await setUnitStatus(tx, app, RsvpStatus.PENDING_APPROVAL);
  return "reopened";
}
