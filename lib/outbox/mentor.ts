import "server-only";

/*
 * Mentor Desk email (docs/MENTOR_DESK.md). Payloads carry ids only; the
 * message is built at send time and dropped when it no longer applies or the
 * recipient no longer belongs (the Space Works notification intents re-check
 * each recipient the same way). Help text is never queued.
 */

import { EventPermission, HelpRequestStatus, MentorAssignmentStatus, OfficeHourBookingStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendMentorNoticeEmail } from "@/lib/email/mentor";
import { formatDayTime } from "@/lib/format/datetime";
import type { OutboxClient } from "./enqueue";
import { isBoundedString, isEmail } from "./payloads";

export const MENTOR_ASSIGNED_KIND = "mentor-assigned";
export const OFFICE_HOUR_BOOKED_KIND = "office-hour-booked";
export const OFFICE_HOUR_CANCELLED_KIND = "office-hour-cancelled";
export const HELP_CLAIMED_KIND = "help-claimed";

const KINDS = new Set([MENTOR_ASSIGNED_KIND, OFFICE_HOUR_BOOKED_KIND, OFFICE_HOUR_CANCELLED_KIND, HELP_CLAIMED_KIND]);

export type MentorMessagePayload = { to: string; id: string; generation?: number };

export function isMentorMessageKind(kind: string) {
  return KINDS.has(kind);
}

export async function enqueueMentorMessages(client: OutboxClient, kind: string, payloads: MentorMessagePayload[]) {
  const unique = [...new Map(payloads.map((p) => [p.to.toLowerCase(), { ...p, to: p.to.toLowerCase() }])).values()];
  if (unique.length === 0) return { count: 0 };
  return client.outboxMessage.createMany({ data: unique.map((payload) => ({ kind, payload: payload as Prisma.InputJsonValue })) });
}

export function asMentorMessagePayload(value: Prisma.JsonValue): MentorMessagePayload | null {
  const p = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!p || !isEmail(p.to) || !isBoundedString(p.id, 64)) return null;
  if (p.generation !== undefined && (typeof p.generation !== "number" || !Number.isInteger(p.generation))) return null;
  return p as MentorMessagePayload;
}

const eventSelect = { id: true, title: true, slug: true, timezone: true, organisationId: true, organisation: { select: { slug: true } } } as const;

/** Addresses of a team's members (account email first, then the registration's). */
async function teamAddresses(teamId: string): Promise<Set<string>> {
  const rows = await prisma.rSVP.findMany({ where: { teamId }, select: { guestEmail: true, user: { select: { email: true } } } });
  return new Set(rows.flatMap((row) => [row.user?.email, row.guestEmail]).filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase()));
}

export async function mentorMessageOrganisation(kind: string, payload: Record<string, unknown>): Promise<string | null> {
  const id = typeof payload.id === "string" ? payload.id : null;
  if (!id) return null;
  if (kind === MENTOR_ASSIGNED_KIND) return (await prisma.mentorTeamAssignment.findUnique({ where: { id }, select: { event: { select: { organisationId: true } } } }))?.event.organisationId ?? null;
  if (kind === HELP_CLAIMED_KIND) return (await prisma.helpRequest.findUnique({ where: { id }, select: { event: { select: { organisationId: true } } } }))?.event.organisationId ?? null;
  return (await prisma.officeHourBooking.findUnique({ where: { id }, select: { slot: { select: { event: { select: { organisationId: true } } } } } }))?.slot.event.organisationId ?? null;
}

/** Sends one Mentor Desk message; "dropped" means it no longer applies; null is an invalid payload. */
export async function deliverMentorMessage(kind: string, value: Prisma.JsonValue, messageId: string): Promise<"sent" | "dropped" | null> {
  const payload = asMentorMessagePayload(value);
  if (!payload) return null;
  if (kind === MENTOR_ASSIGNED_KIND) {
    const row = await prisma.mentorTeamAssignment.findUnique({ where: { id: payload.id }, select: { status: true, eventId: true, mentorUserId: true, team: { select: { name: true } }, mentor: { select: { email: true, name: true } }, event: { select: eventSelect } } });
    if (!row || row.status !== MentorAssignmentStatus.ACTIVE || row.mentor.email?.toLowerCase() !== payload.to) return "dropped";
    const grant = await prisma.eventCollaborator.findFirst({ where: { eventId: row.eventId, userId: row.mentorUserId, permissions: { has: EventPermission.MENTOR } }, select: { id: true } });
    if (!grant) return "dropped";
    await sendMentorNoticeEmail({
      to: payload.to, messageId, recipientName: row.mentor.name ?? undefined,
      subject: `You're mentoring ${row.team.name} · ${row.event.title}`,
      heading: "A new team to mentor",
      lines: [`You are now mentoring team "${row.team.name}" at "${row.event.title}".`, "Open your mentor console to see your teams, the help queue and your office hours."],
      action: { path: `/dashboard/${encodeURIComponent(row.event.organisation.slug)}/event/${encodeURIComponent(row.event.id)}`, label: "Open the mentor console" },
    });
    return "sent";
  }
  if (kind === HELP_CLAIMED_KIND) {
    const row = await prisma.helpRequest.findUnique({ where: { id: payload.id }, select: { status: true, claimGeneration: true, teamId: true, rsvp: { select: { guestEmail: true, user: { select: { email: true } } } }, event: { select: eventSelect } } });
    if (!row || row.status !== HelpRequestStatus.CLAIMED || row.claimGeneration !== payload.generation) return "dropped";
    const allowed = row.teamId ? await teamAddresses(row.teamId) : new Set([row.rsvp?.user?.email, row.rsvp?.guestEmail].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase()));
    if (!allowed.has(payload.to)) return "dropped";
    await sendMentorNoticeEmail({
      to: payload.to, messageId,
      subject: `A mentor is on the way · ${row.event.title}`,
      heading: "Your help request was picked up",
      lines: [`A mentor at "${row.event.title}" claimed your help request and is on the way.`],
    });
    return "sent";
  }
  const booking = await prisma.officeHourBooking.findUnique({
    where: { id: payload.id },
    select: { status: true, teamId: true, team: { select: { name: true } }, slot: { select: { startsAt: true, endsAt: true, location: true, mentor: { select: { email: true, name: true } }, event: { select: eventSelect } } } },
  });
  const wanted = kind === OFFICE_HOUR_BOOKED_KIND ? OfficeHourBookingStatus.BOOKED : OfficeHourBookingStatus.CANCELLED;
  if (!booking || booking.status !== wanted) return "dropped";
  const { slot } = booking;
  const recipients = await teamAddresses(booking.teamId);
  if (slot.mentor.email) recipients.add(slot.mentor.email.toLowerCase());
  if (!recipients.has(payload.to)) return "dropped";
  const when = `${formatDayTime(slot.startsAt, slot.event.timezone)} (${slot.event.timezone})`;
  const mentorName = slot.mentor.name?.trim() || "your mentor";
  const booked = kind === OFFICE_HOUR_BOOKED_KIND;
  await sendMentorNoticeEmail({
    to: payload.to, messageId,
    subject: `${booked ? "Office hour booked" : "Office hour cancelled"} · ${slot.event.title}`,
    heading: booked ? "Office hour booked" : "Office hour cancelled",
    lines: [
      `Team "${booking.team.name}" ${booked ? "is booked" : "is no longer booked"} for office hours with ${mentorName} at "${slot.event.title}".`,
      `When: ${when}${slot.location ? ` · Where: ${slot.location}` : ""}`,
    ],
    calendar: booked ? { uid: payload.id, title: `Office hour · ${slot.event.title}`, startDateTime: slot.startsAt, endDateTime: slot.endsAt, timezone: slot.event.timezone, location: slot.location, description: `Mentor office hour for team ${booking.team.name}. Event timezone: ${slot.event.timezone}` } : undefined,
  });
  return "sent";
}
