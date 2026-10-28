import "server-only";

/** Attendance confirmation email (docs/ATTENDANCE.md): "Are you still coming?". */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendAttendanceCheckEmail } from "@/lib/email/attendance";
import { attendancePath, hashAttendanceToken, isAttendanceTokenShape } from "@/lib/attendanceToken";
import { attendanceCheckOpen } from "@/lib/attendanceCheck";
import { isEligibleRsvp } from "@/lib/core/attendanceCheck/eligible";
import type { OutboxClient } from "./enqueue";
import { isBoundedString, isEmail } from "./payloads";

export const ATTENDANCE_CHECK_KIND = "attendance-check";

/**
 * "Are you still coming?" for one eligible registration. `to` is where it
 * was addressed when queued; delivery sends to the registration's current
 * address. Queued only by an
 * organiser's explicit send or reminder, never by the worker. Carries the raw
 * `/attend/{token}` token (a capability), which exists nowhere else; dropped
 * when the token was rotated, the guest already replied or is no longer
 * eligible, or the event was cancelled, and expired once the event starts.
 */
export type AttendanceCheckPayload = { to: string; rsvpId: string; token: string; reminder?: boolean; };

export async function enqueueAttendanceChecks(client: OutboxClient, payloads: AttendanceCheckPayload[]) {
  if (payloads.length === 0) return { count: 0 };
  return client.outboxMessage.createMany({ data: payloads.map((payload) => ({ kind: ATTENDANCE_CHECK_KIND, payload: payload as Prisma.InputJsonValue })) });
}

export function asAttendanceCheckPayload(value: Prisma.JsonValue): AttendanceCheckPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (!isEmail(p.to) || !isBoundedString(p.rsvpId, 64) || !isAttendanceTokenShape(p.token) || (p.reminder !== undefined && typeof p.reminder !== "boolean")) return null;
  return p as AttendanceCheckPayload;
}

/** The organisation an attendance email is sent as. */
export async function attendanceMessageOrganisation(payload: Record<string, unknown>): Promise<string | null> {
  if (typeof payload.rsvpId !== "string" || payload.rsvpId.length > 64) return null;
  return (await prisma.attendanceCheck.findUnique({ where: { rsvpId: payload.rsvpId }, select: { event: { select: { organisationId: true } } } }))?.event.organisationId ?? null;
}

/**
 * Sends one question. "dropped" means it no longer applies (rotated,
 * answered, no longer eligible, cancelled event) and must not be retried;
 * "expired" means the event has started; null is an invalid payload, which
 * the worker treats as permanent. The email says a No releases the place only
 * when that would actually happen at this moment.
 */
export async function deliverAttendanceCheck(value: Prisma.JsonValue, messageId: string): Promise<"sent" | "dropped" | "expired" | null> {
  const payload = asAttendanceCheckPayload(value);
  if (!payload) return null;
  const check = await prisma.attendanceCheck.findUnique({
    where: { rsvpId: payload.rsvpId },
    select: {
      tokenHash: true,
      response: true,
      eventId: true,
      rsvp: { select: { guestName: true, guestEmail: true, user: { select: { name: true, email: true } } } },
      event: { select: { title: true, status: true, startDateTime: true, timezone: true, location: true, isOnline: true, attendanceCheckReleaseOnDecline: true, organisation: { select: { name: true } } } },
    },
  });
  if (
    !check ||
    check.tokenHash !== hashAttendanceToken(payload.token) ||
    check.response !== null ||
    check.event.status === "CANCELLED" ||
    !(await isEligibleRsvp(prisma, payload.rsvpId, check.eventId))
  ) return "dropped";
  if (!attendanceCheckOpen(check.event.startDateTime)) return "expired";
  // The registration's address now (an account email may have changed since the send).
  const to = (check.rsvp.user?.email ?? check.rsvp.guestEmail ?? "").trim();
  if (!to) return "dropped";
  // Loaded on demand: the release rules pull in the payment operations.
  const release = await (await import("@/lib/core/attendanceCheck/release")).releaseFor(payload.rsvpId, check.event.attendanceCheckReleaseOnDecline);
  await sendAttendanceCheckEmail({
    to,
    eventTitle: check.event.title,
    organisationName: check.event.organisation.name,
    startDateTime: check.event.startDateTime,
    timezone: check.event.timezone,
    location: check.event.isOnline ? "Online" : check.event.location,
    attendPath: attendancePath(payload.token),
    recipientName: check.rsvp.user?.name?.trim() || check.rsvp.guestName?.trim() || undefined,
    reminder: payload.reminder === true,
    releaseKind: release?.kind ?? null,
    releaseRefund: release?.refund ?? null,
    messageId,
  });
  return "sent";
}
