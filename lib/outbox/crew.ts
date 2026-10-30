import "server-only";

/** The crew ticket email (docs/CREW.md): "You're on the crew", with the ticket link. */

import { Prisma, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isCurrentHolderRecipient } from "./holder";
import { sendCrewTicketEmail } from "@/lib/email/crew";
import { designedTicketAttachment } from "@/lib/ticketDesign/resolve";
import type { OutboxClient } from "./enqueue";
import { isBoundedString, isEmail } from "./payloads";

export const CREW_TICKET_KIND = "crew-ticket";

/**
 * A crew member's ticket. The check-in token is a capability, so the message
 * is deleted after delivery. `organisationId` sends it as the organisation.
 * Everything else (name, event, whether it is still a crew ticket) is read at
 * send time, so a removed member or a cancelled event gets nothing.
 */
export type CrewTicketPayload = { to: string; checkInToken: string; organisationId: string };

export async function enqueueCrewTicket(client: OutboxClient, payload: CrewTicketPayload) {
  return client.outboxMessage.create({ data: { kind: CREW_TICKET_KIND, payload: payload as Prisma.InputJsonValue } });
}

export function asCrewTicketPayload(value: Prisma.JsonValue): CrewTicketPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (!isEmail(payload.to) || !isBoundedString(payload.checkInToken, 128) || !isBoundedString(payload.organisationId, 64)) return null;
  return payload as CrewTicketPayload;
}

export function isCrewMessageKind(kind: string) {
  return kind === CREW_TICKET_KIND;
}

/**
 * Sends one crew ticket. "dropped" when the ticket is no longer a confirmed
 * crew ticket of a live event; null for an invalid payload (permanent).
 */
export async function deliverCrewMessage(value: Prisma.JsonValue, messageId: string): Promise<"sent" | "dropped" | null> {
  const payload = asCrewTicketPayload(value);
  if (!payload) return null;
  const rsvp = await prisma.rSVP.findUnique({
    where: { checkInToken: payload.checkInToken },
    select: {
      status: true,
      isCrew: true,
      guestEmail: true, user: { select: { email: true } },
      crewMember: { select: { name: true, role: true } },
      event: { select: { organisationId: true, title: true, status: true, startDateTime: true, endDateTime: true, timezone: true, location: true, isOnline: true } },
    },
  });
  const event = rsvp?.event;
  if (!rsvp?.isCrew || !isCurrentHolderRecipient(rsvp, payload.to) || rsvp.status !== RsvpStatus.CONFIRMED || !rsvp.crewMember || !event || event.organisationId !== payload.organisationId || event.status === "CANCELLED") return "dropped";
  await sendCrewTicketEmail({
    to: payload.to,
    eventTitle: event.title,
    checkInToken: payload.checkInToken,
    recipientName: rsvp.crewMember.name,
    role: rsvp.crewMember.role,
    calendarEvent: { startDateTime: event.startDateTime, endDateTime: event.endDateTime, timezone: event.timezone, location: event.isOnline ? "Online" : event.location },
    ticketPdf: await designedTicketAttachment(payload.checkInToken),
    messageId,
  });
  return "sent";
}
