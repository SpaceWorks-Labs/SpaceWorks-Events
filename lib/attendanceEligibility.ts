import type { Prisma } from "@prisma/client";

/**
 * Who may be asked "Are you still coming?" (docs/ATTENDANCE.md): a CONFIRMED
 * registration of a one-off event. Series dates and passes (registrations
 * keyed by `eventInstanceId`) are never asked.
 *
 * This is the ONE place the rule lives: sending, reminders, shared links,
 * delivery, replies, the Emails card counts and the Guests filters all use
 * it. Event crew (a later branch) adds `isCrew: false` here only.
 *
 * Pure (no Prisma runtime import), so the Guests list query shared with the
 * browser can use it too.
 */
export function attendanceEligibleRsvpWhere(eventId?: string): Prisma.RSVPWhereInput {
  return { status: "CONFIRMED", ...(eventId ? { eventId } : { eventId: { not: null } }) };
}
