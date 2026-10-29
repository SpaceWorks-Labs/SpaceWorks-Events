import "server-only";

import { CREW_EMAIL_REFUSED, hasCrewEmail } from "@/lib/core/crew/shared";
import { ExpenseClaimStatus, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { enqueueOperatorNotice, enqueueRsvpConfirmation } from "@/lib/outbox";
import { AdmissionManagedError, PaymentOperationError } from "./operations";
import { lockOrderTargets, ORDER_SUBJECT_SELECT, orderSubject } from "./targets";
import { newTicketToken, retireHolderCapabilities } from "@/lib/rsvpHolder";

const HOUR = 3_600_000;

/** The holder's expense claims go with their registration; a ticket with claims in play stays with them (`code` for API clients). */
export class OpenClaimsError extends PaymentOperationError {
  readonly code = "OPEN_CLAIMS";
  constructor() {
    super("This ticket has expense claims waiting, approved or paid, so it can't be transferred. Withdraw a waiting claim first, or ask the organisers.");
  }
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
 * ticket that has been used to check in stays where it is. The registrations
 * are locked (by id, after the event or dates) before their check-in state is
 * read, and each write still expects an unused, confirmed ticket, so a
 * concurrent check-in and transfer never both succeed. The previous holder's
 * attendance, submission and team links stop working (lib/rsvpHolder.ts).
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
  // Applications (docs/ADMISSION.md): a place was offered to this person after review, so it can't pass to someone else.
  if (order.eventId && (await prisma.event.count({ where: { id: order.eventId, admissionEnabled: true } }))) throw new AdmissionManagedError("This place was offered to you after your application was reviewed, so it can't be transferred.");
  const settings = order.event ?? order.series;
  const subject = orderSubject(order);

  return prisma.$transaction(async (tx) => {
    await lockOrderTargets(tx, order, now);
    const ticket = await tx.rSVP.findFirst({ where: { id: params.rsvpId, orderId: order.id }, select: { attendeeKey: true, guestEmail: true, user: { select: { email: true } } } });
    if (!ticket) throw new PaymentOperationError("Ticket not found.");
    // Claims are read and withdrawn by registration, so the new holder would see the previous holder's (docs/FINANCE.md).
    const claims = await tx.expenseClaim.count({ where: { rsvp: { orderId: order.id, attendeeKey: ticket.attendeeKey }, status: { in: [ExpenseClaimStatus.SUBMITTED, ExpenseClaimStatus.APPROVED, ExpenseClaimStatus.PAID] } } });
    if (claims > 0) throw new OpenClaimsError();
    // The same person's tickets in this order (every date of a pass) move
    // together. Their rows are locked before check-in state is read: a
    // check-in either lands first (that ticket stays) or waits for this.
    await tx.$queryRaw`SELECT "id" FROM "RSVP" WHERE "orderId" = ${order.id} AND "attendeeKey" = ${ticket.attendeeKey} ORDER BY "id" FOR UPDATE`;
    const confirmed = await tx.rSVP.findMany({
      where: { orderId: order.id, attendeeKey: ticket.attendeeKey, status: RsvpStatus.CONFIRMED },
      select: { id: true, checkedInAt: true, eventInstance: { select: { startDateTime: true } } },
    });
    const seats = confirmed.filter((seat) => seat.checkedInAt == null);
    if (confirmed.length > 0 && seats.length === 0) throw new PaymentOperationError("This ticket has already been used to check in, so it can't be transferred.");
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
      const moved = await tx.rSVP.updateMany({
        where: { id: seat.id, status: RsvpStatus.CONFIRMED, checkedInAt: null },
        data: { userId: null, guestEmail: email, guestName: params.name.trim(), attendeeKey: `guest:${email}`, checkInToken: token },
      });
      if (moved.count !== 1) throw new PaymentOperationError("This ticket was changed meanwhile. Refresh and try again.");
      await retireHolderCapabilities(tx, seat.id);
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
