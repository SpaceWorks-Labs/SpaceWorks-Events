import "server-only";

import { prisma } from "@/lib/db";
import { hashAttendanceToken, isAttendanceTokenShape } from "@/lib/attendanceToken";
import {
  attendanceReplyClosedReason,
  type AttendanceReleaseKind,
  type AttendanceReplyClosed,
  type AttendanceResponseValue,
} from "@/lib/attendanceCheck";
import { isEligibleRsvp } from "./shared";
import { releaseFor } from "./release";

export type AttendanceFormView = {
  eventTitle: string;
  organisationName: string;
  startDateTime: string;
  endDateTime: string;
  timezone: string;
  location: string;
  isOnline: boolean;
  accentColor: string | null;
  attendeeName: string;
  attendeeEmail: string;
  teamName: string | null;
  response: AttendanceResponseValue | null;
  respondedAt: string | null;
  note: string;
  /** What a "No" would release right now; null keeps the place (release off, or a paid ticket organisers handle). */
  releaseKind: AttendanceReleaseKind | null;
  /** For a paid release: the refund the buyer policy gives, formatted (null when nothing comes back). */
  releaseRefund: string | null;
  closed: AttendanceReplyClosed | null;
};

const VIEW_SELECT = {
  rsvpId: true,
  eventId: true,
  response: true,
  respondedAt: true,
  note: true,
  rsvp: { select: { guestName: true, guestEmail: true, user: { select: { name: true, email: true } }, team: { select: { name: true } } } },
  event: {
    select: {
      title: true, status: true, startDateTime: true, endDateTime: true, timezone: true, location: true, isOnline: true,
      attendanceCheckReleaseOnDecline: true, organisation: { select: { name: true } }, page: { select: { accentColor: true } },
    },
  },
} as const;

/**
 * The form's view for a raw link token, or null for a malformed, rotated or
 * unknown token (the page answers a real 404). Only this registration's own
 * name, email and answer; never other attendees, the ticket token, the RSVP
 * id or check-in state. The digest is used to look the row up, never read.
 */
export async function resolveAttendanceCheckByToken(rawToken: string, now: Date = new Date()): Promise<AttendanceFormView | null> {
  if (!isAttendanceTokenShape(rawToken)) return null;
  const check = await prisma.attendanceCheck.findUnique({ where: { tokenHash: hashAttendanceToken(rawToken) }, select: VIEW_SELECT });
  if (!check) return null;
  const eligible = await isEligibleRsvp(prisma, check.rsvpId, check.eventId);
  const closed = attendanceReplyClosedReason({ eligible, eventStart: check.event.startDateTime, eventStatus: check.event.status, now });
  const email = check.rsvp.user?.email ?? check.rsvp.guestEmail ?? "";
  const release = closed ? null : await releaseFor(check.rsvpId, check.event.attendanceCheckReleaseOnDecline, now);
  return {
    eventTitle: check.event.title,
    organisationName: check.event.organisation.name,
    startDateTime: check.event.startDateTime.toISOString(),
    endDateTime: check.event.endDateTime.toISOString(),
    timezone: check.event.timezone,
    location: check.event.location,
    isOnline: check.event.isOnline,
    accentColor: check.event.page?.accentColor ?? null,
    attendeeName: check.rsvp.user?.name?.trim() || check.rsvp.guestName?.trim() || email.split("@")[0] || "Guest",
    attendeeEmail: email,
    teamName: check.rsvp.team?.name ?? null,
    response: check.response,
    respondedAt: check.respondedAt?.toISOString() ?? null,
    note: check.note ?? "",
    releaseKind: release?.kind ?? null,
    releaseRefund: release?.refund ?? null,
    closed,
  };
}
