import "server-only";

import { EventPrivacyType, OrderStatus, PaymentStatus, RegistrationMode, RsvpStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { enqueueRsvpStatusNotification } from "@/lib/outbox";
import { emitTeamWebhooks, promoteOldestWaitlistedUnit, type RegistrationStatusWebhook } from "@/lib/teamUnits";
import { enqueuePaymentEmail } from "../email";
import { HOLD_EXTENSION_CAP_MS, PAYMENT_LINK_HOLD_MS } from "../holds";
import { providerMinimumMinor } from "../money";
import { hasFreeSeats, lockSeriesDates, ORDER_SUBJECT_SELECT, orderSubject, seatTargetOf, type SeatTarget } from "../targets";
import { attendeeEmail, lockOrder, onlineAccount, PaymentOperationError, subjectTitle, ZERO } from "./shared";

/**
 * Offer a paid request (approved, or reached on the waitlist) its seats: the
 * order holds them for a day with one pending payment and the buyer is
 * emailed a link. The checkout page opens only when they click Pay.
 */
export async function offerInTransaction(tx: Prisma.TransactionClient, params: { orderId: string; organisationId: string; provider: "RAZORPAY" | "STRIPE"; testMode: boolean; actorUserId: string | null; now: Date; }) {
  await lockOrder(tx, params.orderId);
  const order = await tx.order.findFirst({
    where: { id: params.orderId, organisationId: params.organisationId },
    select: { id: true, status: true, totalMinor: true, currency: true, buyerEmail: true, ...ORDER_SUBJECT_SELECT, rsvps: { select: { id: true, orderId: true, eventId: true, eventInstanceId: true, ticketTypeId: true, status: true } } },
  });
  if (!order || order.status !== OrderStatus.REQUESTED || order.rsvps.length === 0) throw new PaymentOperationError("This request was changed by someone else.");
  const subject = orderSubject(order);
  if (!subject || !subject.open(params.now)) throw new PaymentOperationError("This event is no longer open for registration.");
  if (order.totalMinor < providerMinimumMinor(params.provider, order.currency)) throw new PaymentOperationError("This order is below the smallest payment the provider accepts.");
  if (!(await hasFreeSeats(tx, order.rsvps, params.now))) throw new PaymentOperationError("There aren't enough free places for this order yet.");
  const holdExpiresAt = new Date(params.now.getTime() + PAYMENT_LINK_HOLD_MS);
  await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.PENDING, holdExpiresAt, holdCapAt: new Date(holdExpiresAt.getTime() + HOLD_EXTENSION_CAP_MS), testMode: params.testMode } });
  await tx.rSVP.updateMany({ where: { orderId: order.id }, data: { status: RsvpStatus.PENDING_PAYMENT, holdExpiresAt } });
  const payment = await tx.payment.create({
    data: { organisationId: params.organisationId, orderId: order.id, amountMinor: order.totalMinor, currency: order.currency, provider: params.provider, testMode: params.testMode, description: subject.title.slice(0, 300) },
    select: { id: true },
  });
  await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: payment.id, notice: "pending" });
  await recordAuditEvent({ action: "ORDER_OFFERED", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Order", targetId: order.id, client: tx });
}

export async function offerRequestedOrder(params: { orderId: string; organisationId: string; actorUserId: string | null; now?: Date; }) {
  const account = await onlineAccount(params.organisationId);
  await prisma.$transaction((tx) => offerInTransaction(tx, { ...params, provider: account.provider, testMode: account.testMode, now: params.now ?? new Date() }));
}

/** Decline a paid request: nothing was charged; its registrations are rejected. */
export async function declineRequestedOrder(params: { orderId: string; organisationId: string; actorUserId: string; }) {
  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, params.orderId);
    const order = await tx.order.findFirst({
      where: { id: params.orderId, organisationId: params.organisationId },
      select: { id: true, status: true, buyerEmail: true, buyerName: true, ...ORDER_SUBJECT_SELECT },
    });
    if (!order || order.status !== OrderStatus.REQUESTED) throw new PaymentOperationError("This request was changed by someone else.");
    await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
    await tx.rSVP.updateMany({ where: { orderId: order.id }, data: { status: RsvpStatus.REJECTED } });
    await enqueueRsvpStatusNotification(tx, { to: order.buyerEmail, organisationId: params.organisationId, eventTitle: subjectTitle(order), approved: false, recipientName: order.buyerName || undefined });
    await recordAuditEvent({ action: "ORDER_DECLINED", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Order", targetId: order.id, client: tx });
  });
}

/**
 * Seats came free: offer them to the head of the waitlist. A free waitlisted
 * registration is confirmed; a paid request is offered a payment link. Only
 * the first in line is tried, so nobody is skipped for a smaller order.
 */
export async function offerNextWaitlisted(target: SeatTarget, now = new Date()): Promise<boolean> {
  let owner: { organisationId: string; privacyType: EventPrivacyType; title: string; seriesId: string | null; } | null = null;
  if ("eventId" in target) {
    const event = await prisma.event.findUnique({ where: { id: target.eventId }, select: { organisationId: true, privacyType: true, title: true, registrationMode: true } });
    if (event?.registrationMode === RegistrationMode.TEAM) return promoteNextTeamUnit(target.eventId);
    owner = event ? { organisationId: event.organisationId, privacyType: event.privacyType, title: event.title, seriesId: null } : null;
  } else {
    const date = await prisma.eventInstance.findUnique({ where: { id: target.eventInstanceId }, select: { eventSeriesId: true, series: { select: { organisationId: true, privacyType: true, title: true } } } });
    owner = date ? { ...date.series, seriesId: date.eventSeriesId } : null;
  }
  if (!owner || owner.privacyType === EventPrivacyType.APPROVAL_REQUIRED) return false;
  const { seriesId } = owner;
  const next = await prisma.rSVP.findFirst({
    where: { ...target, status: RsvpStatus.WAITLISTED },
    orderBy: { createdAt: "asc" },
    select: { id: true, orderId: true, eventId: true, eventInstanceId: true, ticketTypeId: true, checkInToken: true, guestEmail: true, user: { select: { email: true } }, order: { select: { status: true, totalMinor: true } } },
  });
  if (!next) return false;
  if (next.order && next.order.totalMinor > ZERO) {
    if (next.order.status !== OrderStatus.REQUESTED) return false;
    return offerRequestedOrder({ orderId: next.orderId!, organisationId: owner.organisationId, actorUserId: null, now }).then(() => true, () => false);
  }
  return prisma.$transaction(async (tx) => {
    if ("eventId" in target) await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${target.eventId} FOR UPDATE`;
    else if (seriesId) await lockSeriesDates(tx, seriesId, [target.eventInstanceId], now);
    if (!(await hasFreeSeats(tx, [next], now))) return false;
    const promoted = await tx.rSVP.updateMany({ where: { id: next.id, status: RsvpStatus.WAITLISTED }, data: { status: RsvpStatus.CONFIRMED } });
    const to = attendeeEmail(next);
    if (promoted.count === 1 && to) await enqueueRsvpStatusNotification(tx, { to, eventTitle: owner.title, approved: true, checkInToken: next.checkInToken });
    return promoted.count === 1;
  });
}

/**
 * TEAM events (docs/TEAMS.md) promote whole units: the oldest waitlisted
 * team or solo registration, when a unit is free. Paid team places are paid
 * up front, so only free registrations ever wait.
 */
async function promoteNextTeamUnit(eventId: string) {
  const webhooks: RegistrationStatusWebhook[] = [];
  const promoted = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true, title: true, capacity: true, privacyType: true } });
    const unit = event ? await promoteOldestWaitlistedUnit(tx, event) : null;
    if (unit) webhooks.push(...unit.webhooks);
    return unit != null;
  });
  emitTeamWebhooks(webhooks);
  return promoted;
}

/** Offer every free seat, in waitlist order, until the seats or the waitlist run out. Returns how many were offered. */
export async function fillFromWaitlist(target: SeatTarget, now = new Date(), limit = 100) {
  let offered = 0;
  while (offered < limit && (await offerNextWaitlisted(target, now).catch(() => false))) offered += 1;
  return offered;
}

/**
 * The beat's safety net: free seats on upcoming events and dates go to their
 * waitlists, after a capacity increase, a removed guest, or a promotion that
 * failed after its commit.
 */
export async function fillWaitlists(now = new Date()) {
  const waiting = await prisma.rSVP.groupBy({
    by: ["eventId", "eventInstanceId"],
    where: {
      status: RsvpStatus.WAITLISTED,
      OR: [
        { event: { endDateTime: { gt: now }, privacyType: { not: EventPrivacyType.APPROVAL_REQUIRED } } },
        { eventInstance: { endDateTime: { gt: now }, cancelledAt: null, series: { privacyType: { not: EventPrivacyType.APPROVAL_REQUIRED } } } },
      ],
    },
    orderBy: [{ eventId: "asc" }, { eventInstanceId: "asc" }],
    take: 200,
  });
  let offered = 0;
  for (const row of waiting) {
    const target = seatTargetOf(row);
    if (target) offered += await fillFromWaitlist(target, now);
  }
  return { offered };
}

/**
 * Email the buyer a payment link: the same link again while seats are held,
 * or a fresh day-long hold for an order whose hold ended (if its places are
 * still free) or a request still waiting.
 */
export async function sendPaymentLink(params: { orderId: string; organisationId: string; actorUserId: string; now?: Date; }): Promise<"resent" | "reopened"> {
  const now = params.now ?? new Date();
  const order = await prisma.order.findFirst({
    where: { id: params.orderId, organisationId: params.organisationId },
    select: { id: true, status: true, holdExpiresAt: true, buyerEmail: true, payments: { where: { status: PaymentStatus.PENDING }, select: { id: true } } },
  });
  if (!order) throw new PaymentOperationError("Order not found.");
  if (order.status === OrderStatus.PENDING && order.holdExpiresAt && order.holdExpiresAt > now && order.payments[0]) {
    await enqueuePaymentEmail(prisma, { to: order.buyerEmail, paymentId: order.payments[0].id, notice: "pending" });
    await recordAuditEvent({ action: "PAYMENT_LINK_SENT", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Order", targetId: order.id });
    return "resent";
  }
  if (order.status === OrderStatus.REQUESTED) {
    await offerRequestedOrder(params);
    return "reopened";
  }
  if (order.status !== OrderStatus.EXPIRED) throw new PaymentOperationError("This order isn't waiting for payment.");
  const account = await onlineAccount(params.organisationId);
  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order.id);
    const current = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true, totalMinor: true, currency: true, buyerEmail: true, ...ORDER_SUBJECT_SELECT, rsvps: { select: { id: true, orderId: true, eventId: true, eventInstanceId: true, ticketTypeId: true } } },
    });
    if (current.status !== OrderStatus.EXPIRED) throw new PaymentOperationError("This order was changed by someone else.");
    if (current.rsvps.length === 0) throw new PaymentOperationError("The buyer has registered again since this order expired.");
    if (current.totalMinor < providerMinimumMinor(account.provider, current.currency)) throw new PaymentOperationError("This order is below the smallest payment the provider accepts.");
    if (!(await hasFreeSeats(tx, current.rsvps, now))) throw new PaymentOperationError("Its places have gone since the hold ended.");
    const holdExpiresAt = new Date(now.getTime() + PAYMENT_LINK_HOLD_MS);
    await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.PENDING, holdExpiresAt, holdCapAt: new Date(holdExpiresAt.getTime() + HOLD_EXTENSION_CAP_MS), testMode: account.testMode } });
    await tx.rSVP.updateMany({ where: { orderId: order.id }, data: { status: RsvpStatus.PENDING_PAYMENT, holdExpiresAt } });
    const payment = await tx.payment.create({
      data: { organisationId: params.organisationId, orderId: order.id, amountMinor: current.totalMinor, currency: current.currency, provider: account.provider, testMode: account.testMode, description: subjectTitle(current).slice(0, 300) },
      select: { id: true },
    });
    await enqueuePaymentEmail(tx, { to: current.buyerEmail, paymentId: payment.id, notice: "pending" });
    await recordAuditEvent({ action: "PAYMENT_LINK_SENT", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Order", targetId: order.id, client: tx });
  });
  return "reopened";
}
