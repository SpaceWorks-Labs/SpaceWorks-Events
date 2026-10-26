import "server-only";

import { CheckoutAttemptStatus, OfflinePaymentMethod, OrderStatus, PaymentStatus, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { enqueueRsvpConfirmation } from "@/lib/outbox";
import { closeOpenAttempts } from "../checkout";
import { enqueueOrderEmail, enqueuePaymentEmail } from "../email";
import { isActiveHold } from "../holds";
import { effectiveOfflineRecord } from "../offlineRecord";
import { hasFreeSeats, ORDER_SUBJECT_SELECT } from "../targets";
import { attendeeEmail, lockOrder, PaymentOperationError, subjectTitle } from "./shared";
import { heldStatusWebhooks } from "../settlement";
import { placePaidTeamOrder } from "../teamOrders";
import { confirmEntryFeeTx } from "../entryFees";
import { noticeOrganisersOfRequest } from "@/lib/notices";
import { emitWebhookEvent, type WebhookEmission } from "@/lib/webhooks/emit";

/**
 * Settle a pending order by hand: money collected in person, or the tickets
 * made complimentary. Open provider pages are cancelled first, so the buyer
 * can't also pay online; if they already had, that payment stands instead.
 */
export async function settleOrderByHand(params: {
  orderId: string;
  organisationId: string;
  actorUserId: string;
  mode: "offline" | "waive";
  method?: OfflinePaymentMethod;
  reference?: string | null;
  now?: Date;
}): Promise<"confirmed" | "already-paid"> {
  const now = params.now ?? new Date();
  const owned = await prisma.order.findFirst({ where: { id: params.orderId, organisationId: params.organisationId }, select: { id: true } });
  if (!owned) throw new PaymentOperationError("Order not found.");
  const pages = await closeOpenAttempts(owned.id, now);
  if (pages === "settled") return "already-paid";
  if (pages === "open") throw new PaymentOperationError("The buyer's payment page couldn't be closed yet. Try again in a minute.");

  const webhooks: WebhookEmission[] = [];
  const settledBy = () => (params.mode === "offline"
    ? { status: PaymentStatus.PAID_OFFLINE, paidAt: now, offlineMethod: params.method ?? OfflinePaymentMethod.OTHER, offlineReference: params.reference?.trim().slice(0, 120) || null, settledByUserId: params.actorUserId }
    : { status: PaymentStatus.WAIVED, settledByUserId: params.actorUserId });
  const outcome = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, owned.id);
    const order = await tx.order.findUniqueOrThrow({
      where: { id: owned.id },
      select: {
        id: true, status: true, buyerEmail: true, buyerName: true, eventId: true, teamId: true, teamName: true, submissionId: true, ...ORDER_SUBJECT_SELECT,
        payments: { where: { status: PaymentStatus.PENDING }, select: { id: true, provider: true } },
        rsvps: { select: { id: true, orderId: true, eventId: true, eventInstanceId: true, ticketTypeId: true, status: true, holdExpiresAt: true, checkInToken: true, guestEmail: true, user: { select: { email: true } } } },
      },
    });
    // Reserved to pay at the desk: the places are already confirmed; record the money.
    const desk = order.status === OrderStatus.CONFIRMED ? order.payments.find((payment) => payment.provider === "OFFLINE") : undefined;
    if (desk) {
      await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${desk.id} FOR UPDATE`;
      await tx.payment.update({
        where: { id: desk.id },
        data: settledBy(),
      });
      if (params.mode === "offline") await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: desk.id, notice: "paid" });
      await recordAuditEvent({ action: params.mode === "offline" ? "PAYMENT_COLLECTED_AT_DESK" : "PAYMENT_WAIVED", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Payment", targetId: desk.id, client: tx });
      return "confirmed" as const;
    }
    if (order.status === OrderStatus.CONFIRMED) return "already-paid" as const;
    const payment = order.payments[0];
    if (order.status !== OrderStatus.PENDING || !payment) throw new PaymentOperationError("Only orders waiting for payment can be settled by hand.");
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${payment.id} FOR UPDATE`;
    // A project entry fee (docs/HACKATHON.md) holds no places: record it and submit the project.
    if (order.submissionId && order.rsvps.length === 0) {
      await tx.paymentCheckoutAttempt.updateMany({ where: { paymentId: payment.id, status: CheckoutAttemptStatus.OPEN }, data: { status: CheckoutAttemptStatus.CANCELLED } });
      await tx.payment.update({ where: { id: payment.id }, data: settledBy() });
      await confirmEntryFeeTx(tx, { id: order.id, organisationId: params.organisationId, submissionId: order.submissionId, buyerEmail: order.buyerEmail, buyerName: order.buyerName }, payment.id, now, params.mode === "offline");
      await recordAuditEvent({ action: params.mode === "offline" ? "PAYMENT_MARKED_PAID_OFFLINE" : "PAYMENT_WAIVED", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Payment", targetId: payment.id, client: tx });
      return "confirmed" as const;
    }
    const held = order.rsvps.filter((rsvp) => rsvp.status === RsvpStatus.PENDING_PAYMENT);
    if (held.length === 0) throw new PaymentOperationError("This order has no tickets left to confirm.");
    const holdActive = held.every((rsvp) => isActiveHold(rsvp, now));
    // TEAM events place the one registration in its team or unit (docs/TEAMS.md).
    const team = held.length === 1 ? await placePaidTeamOrder(tx, order, held[0]!.id, holdActive, now) : null;
    if (team === "gone" || (!team && !holdActive && !(await hasFreeSeats(tx, held, now)))) throw new PaymentOperationError("The hold ended and the places have gone.");
    const status = team?.status ?? RsvpStatus.CONFIRMED;

    await tx.paymentCheckoutAttempt.updateMany({ where: { paymentId: payment.id, status: CheckoutAttemptStatus.OPEN }, data: { status: CheckoutAttemptStatus.CANCELLED } });
    await tx.payment.update({
      where: { id: payment.id },
      data: settledBy(),
    });
    await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED, holdExpiresAt: null, holdCapAt: null } });
    await tx.rSVP.updateMany({ where: { id: { in: held.map((rsvp) => rsvp.id) } }, data: { status, holdExpiresAt: null } });
    webhooks.push(...heldStatusWebhooks(held.map((rsvp) => rsvp.id), status));
    if (status === RsvpStatus.PENDING_APPROVAL && order.eventId) await noticeOrganisersOfRequest(tx, { eventId: order.eventId });
    if (params.mode === "offline") await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: payment.id, notice: "paid" });
    // One ticket email per person (a pass's ticket page lists its other dates).
    const emailed = new Set<string>();
    for (const rsvp of held) {
      const to = attendeeEmail(rsvp);
      if (!to || emailed.has(to)) continue;
      emailed.add(to);
      await enqueueRsvpConfirmation(tx, { to, eventTitle: subjectTitle(order), status, checkInToken: rsvp.checkInToken, ...(team?.teamName ? { teamName: team.teamName } : {}) });
    }
    if (held.some((rsvp) => !attendeeEmail(rsvp))) await enqueueOrderEmail(tx, { to: order.buyerEmail, orderId: order.id, notice: "attendee-details" });
    await recordAuditEvent({ action: params.mode === "offline" ? "PAYMENT_MARKED_PAID_OFFLINE" : "PAYMENT_WAIVED", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Payment", targetId: payment.id, client: tx });
    return "confirmed" as const;
  });
  for (const webhook of webhooks) emitWebhookEvent(webhook);
  return outcome;
}

/**
 * Correct how an offline payment was recorded. The payment row never
 * changes; each correction is an append-only amendment.
 */
export async function amendOfflinePayment(params: {
  paymentId: string;
  organisationId: string;
  actorUserId: string;
  method?: OfflinePaymentMethod;
  reference?: string | null;
  reason: string;
}) {
  const reason = params.reason.trim().slice(0, 500);
  if (!reason) throw new PaymentOperationError("Say why the record is being corrected.");
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: params.paymentId, organisationId: params.organisationId, status: PaymentStatus.PAID_OFFLINE },
      select: { id: true, offlineMethod: true, offlineReference: true, amendments: { orderBy: { createdAt: "asc" }, select: { field: true, newValue: true } } },
    });
    if (!payment) throw new PaymentOperationError("Only offline payments can be corrected.");
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${payment.id} FOR UPDATE`;
    const current = effectiveOfflineRecord(payment);
    const changes: Array<{ field: "offlineMethod" | "offlineReference"; oldValue: string | null; newValue: string | null; }> = [];
    if (params.method && params.method !== current.method) changes.push({ field: "offlineMethod", oldValue: current.method, newValue: params.method });
    const reference = params.reference === undefined ? current.reference : params.reference?.trim().slice(0, 120) || null;
    if (reference !== current.reference) changes.push({ field: "offlineReference", oldValue: current.reference, newValue: reference });
    if (changes.length === 0) throw new PaymentOperationError("Nothing changed.");
    await tx.paymentAmendment.createMany({ data: changes.map((change) => ({ paymentId: payment.id, ...change, reason, actorUserId: params.actorUserId })) });
    await recordAuditEvent({ action: "PAYMENT_AMENDED", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Payment", targetId: payment.id, metadata: { fields: changes.map((change) => change.field).join(",") }, client: tx });
  });
}
