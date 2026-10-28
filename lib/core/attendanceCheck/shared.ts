import "server-only";

import { revalidatePath as nextRevalidatePath } from "next/cache";
import { type EventStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { canManageEvents, getMembership } from "@/lib/permissions";
import { ATTENDANCE_REMINDER_INTERVAL_MS } from "@/lib/attendanceCheck";
import { attendanceEligibleRsvpWhere } from "@/lib/attendanceEligibility";

/*
 * Attendance confirmation ("Are you still coming?", docs/ATTENDANCE.md).
 *
 * MANUAL ONLY: nothing here runs on a timer, and the outbox worker never
 * creates an AttendanceCheck. Every email is queued by an explicit organiser
 * action (send, or remind people who have not replied), and every shared link
 * is issued by one, with the exact permission of the Emails tab's broadcasts:
 * organisation OWNER/ADMIN (`canManageEvents` after the staff authenticator
 * check in `getMembership`). No co-organiser grant covers emailing guests.
 */

export { isEligibleRsvp } from "./eligible";

export const revalidatePath = trackedRevalidation(nextRevalidatePath);

/** Audit actions; the Emails card reads the latest send and the release count from them. */
export const ATTENDANCE_AUDIT = {
  sent: "ATTENDANCE_CHECK_SENT",
  reminded: "ATTENDANCE_CHECK_REMINDED",
  settings: "ATTENDANCE_CHECK_SETTINGS_UPDATED",
  released: "ATTENDANCE_CHECK_RELEASED",
  linkShared: "ATTENDANCE_CHECK_LINK_SHARED",
  keptPaid: "ATTENDANCE_CHECK_PAID_KEPT",
} as const;

export const SEND_PERMISSION_ERROR = "You do not have permission to email attendees.";
export const CANCELLED_ERROR = "This event is cancelled, so guests cannot be asked.";
export const STARTED_ERROR = "This event has started, so guests can no longer be asked.";

export type AttendanceContext =
  | { ok: false; error: string; }
  | {
      ok: true;
      org: { id: string; slug: string; };
      event: { id: string; title: string; status: EventStatus; startDateTime: Date; attendanceCheckReleaseOnDecline: boolean; };
    };

/** The broadcast composer's access rule, exactly: organisation owners and admins of the event's organisation. */
export async function requireAttendanceContext(userId: string, organisationSlug: string, eventId: string): Promise<AttendanceContext> {
  const org = await prisma.organisation.findUnique({ where: { slug: organisationSlug }, select: { id: true, slug: true } });
  if (!org) return { ok: false, error: "Organisation not found." };
  const membership = await getMembership(userId, org.id);
  if (!canManageEvents(membership)) return { ok: false, error: SEND_PERMISSION_ERROR };
  const event = await prisma.event.findFirst({
    where: { id: eventId, organisationId: org.id },
    select: { id: true, title: true, status: true, startDateTime: true, attendanceCheckReleaseOnDecline: true },
  });
  if (!event) return { ok: false, error: "Event not found." };
  return { ok: true, org, event };
}

/** Eligible registrations of the event that have not been asked yet. */
export function unaskedWhere(eventId: string): Prisma.RSVPWhereInput {
  return { AND: [attendanceEligibleRsvpWhere(eventId), { attendanceCheck: { is: null } }] };
}

/** Not-replied checks of still-eligible guests whose last email is at least 12 hours old. */
export function remindableWhere(eventId: string, now: Date): Prisma.AttendanceCheckWhereInput {
  return {
    eventId,
    response: null,
    sentAt: { lte: new Date(now.getTime() - ATTENDANCE_REMINDER_INTERVAL_MS) },
    rsvp: attendanceEligibleRsvpWhere(eventId),
  };
}

/** Not-replied checks of still-eligible guests (the "No reply" count). */
export function noReplyWhere(eventId: string): Prisma.AttendanceCheckWhereInput {
  return { eventId, response: null, rsvp: attendanceEligibleRsvpWhere(eventId) };
}

export function recipientEmail(rsvp: { guestEmail: string | null; user: { email: string | null; } | null; }): string | null {
  const email = (rsvp.user?.email ?? rsvp.guestEmail ?? "").trim();
  return email || null;
}

/** Lock the event row (serialises sends, reminders and shared links) and re-read its deadline. */
export async function lockOpenEvent(tx: Prisma.TransactionClient, eventId: string, startedError = STARTED_ERROR): Promise<string | null> {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
  const locked = await tx.event.findUnique({ where: { id: eventId }, select: { startDateTime: true, status: true } });
  if (locked?.status === "CANCELLED") return CANCELLED_ERROR;
  if (!locked || locked.startDateTime.getTime() <= Date.now()) return startedError;
  return null;
}
