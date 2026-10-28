import "server-only";

import { CREW_EMAIL_REFUSED, hasCrewEmail } from "@/lib/core/crew/shared";
import crypto from "node:crypto";
import { RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { enqueueOperatorNotice, enqueueRsvpConfirmation } from "@/lib/outbox";
import { PaymentOperationError } from "./operations";
import { lockOrderTargets, ORDER_SUBJECT_SELECT, orderSubject } from "./targets";

const HOUR = 3_600_000;

/** A new ticket link: the old one stops working once a ticket changes hands. */
function newTicketToken() {
  return crypto.randomBytes(18).toString("base64url");
}

/**
 * Whether this order's tickets can change hands now, and until when: the
 * organiser allows transfers, up to their cut-off before the start (for a
 * series, before the ticket's own date).
 */
export function transferWindow(settings: { allowTransfers: boolean; transferCutoffHours: number; } | null, start: Date | null, now = new Date()) {
  if (!settings?.allowTransfers || !start) return null;
  const until = new Date(start.getTime() - settings.transferCutoffHours * HOUR);
  return until > now ? until : null;
}

/**
 * The buyer passes one person's tickets to someone else (for a pass, every
 * date still ahead). The tickets get new links, so the old ones stop working;
 * the new holder is emailed their ticket and the old address is told. A
 * ticket that has been used to check in stays where it is.
 */
export async function transferTicket(params: { orderToken: string; rsvpId: string; name: string; email: string; now?: Date; }) {
  const now = params.now ?? new Date();
  const email = params.email.trim().toLowerCase();
  const order = await prisma.order.findUnique({
    where: { accessToken: params.orderToken },
    select: {
      id: true, organisationId: true, status: true, eventId: true, eventSeriesId: true, ...ORDER_SUBJECT_SELECT,
      event: { select: { ...ORDER_SUBJECT_SELECT.event.select, allowTransfers: true, transferCutoffHours: true } },
      series: { select: { ...ORDER_SUBJECT_SELECT.series.select, allowTransfers: true, transferCutoffHours: true } },
    },
  });
  if (!order || order.status !== "CONFIRMED") throw new PaymentOperationError("Only confirmed tickets can be transferred.");
  const settings = order.event ?? order.series;
  const subject = orderSubject(order);

  return prisma.$transaction(async (tx) => {
    await lockOrderTargets(tx, order, now);
    const ticket = await tx.rSVP.findFirst({ where: { id: params.rsvpId, orderId: order.id }, select: { attendeeKey: true, guestEmail: true, user: { select: { email: true } } } });
    if (!ticket) throw new PaymentOperationError("Ticket not found.");
    // The same person's tickets in this order (every date of a pass) move together.
    const seats = await tx.rSVP.findMany({
      where: { orderId: order.id, attendeeKey: ticket.attendeeKey, status: RsvpStatus.CONFIRMED, checkedInAt: null },
      select: { id: true, eventInstance: { select: { startDateTime: true } } },
    });
    const movable = seats.filter((seat) => {
      const start = seat.eventInstance?.startDateTime ?? order.event?.startDateTime ?? null;
      return transferWindow(settings, start, now) != null;
    });
    if (movable.length === 0) {
      throw new PaymentOperationError(settings?.allowTransfers ? "It's too close to the start to transfer this ticket." : "The organiser doesn't allow tickets to be transferred.");
    }
    const previous = ticket.user?.email?.trim() || ticket.guestEmail;
    if (previous?.toLowerCase() === email) throw new PaymentOperationError("That's already who holds this ticket.");
    // A crew member already holds a free crew ticket for the event (docs/CREW.md).
    if (order.eventId && (await hasCrewEmail(tx, order.eventId, [email]))) throw new PaymentOperationError(CREW_EMAIL_REFUSED);
    let firstToken: string | null = null;
    for (const seat of movable) {
      const token = newTicketToken();
      firstToken ??= token;
      await tx.rSVP.update({
        where: { id: seat.id },
        data: { userId: null, guestEmail: email, guestName: params.name.trim(), attendeeKey: `guest:${email}`, checkInToken: token },
      });
    }
    await enqueueRsvpConfirmation(tx, { to: email, eventTitle: subject?.title ?? "your event", status: RsvpStatus.CONFIRMED, checkInToken: firstToken! });
    if (previous) {
      await enqueueOperatorNotice(tx, {
        organisationId: order.organisationId,
        to: previous,
        subject: `Your ticket was transferred: ${subject?.title ?? "your event"}`,
        lines: [`Your ticket for ${subject?.title ?? "the event"} now belongs to ${params.name.trim()}. Your old ticket link no longer works.`],
      });
    }
    await recordAuditEvent({ action: "TICKET_TRANSFERRED", organisationId: order.organisationId, targetType: "RSVP", targetId: params.rsvpId, metadata: { tickets: movable.length }, client: tx });
    return { moved: movable.length };
  });
}
