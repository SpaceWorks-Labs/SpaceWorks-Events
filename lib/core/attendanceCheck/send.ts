import "server-only";

import { prisma } from "@/lib/db";
import { sqlUtcTimestamp } from "@/lib/sqlTimestamp";
import { attendanceCheckRefSchema, attendanceCheckSettingsSchema } from "@/lib/validators";
import type { ActionResult } from "@/app/actions/org";
import { recordAuditEvent } from "@/lib/audit";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { enqueueAttendanceChecks, type AttendanceCheckPayload } from "@/lib/outbox/attendance";
import { startOutboxWorker } from "@/lib/outboxWorker";
import { generateAttendanceToken } from "@/lib/attendanceToken";
import { ATTENDANCE_REMINDER_INTERVAL_MS } from "@/lib/attendanceCheck";
import { ATTENDANCE_AUDIT, lockOpenEvent, recipientEmail, remindableWhere, requireAttendanceContext, revalidatePath, unaskedWhere } from "./shared";

const TOO_MANY = "Too many attendance emails sent recently. Please wait before sending again.";

/**
 * Ask every eligible guest who has not been asked yet. Safe to repeat: the
 * Event row lock serialises concurrent sends and the unique `rsvpId` skips
 * anyone already asked, so a second click (or a second organiser) asks only
 * people confirmed since. Allowed until the event starts.
 */
export async function sendAttendanceChecksForUser(actorUserId: string | null, input: unknown): Promise<ActionResult<{ queued: number; }>> {
  if (!actorUserId) return { ok: false, error: "You must be signed in." };
  const parsed = attendanceCheckRefSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  if (await isActionRateLimited("attendanceCheckSend", actorUserId)) return { ok: false, error: TOO_MANY };
  const context = await requireAttendanceContext(actorUserId, parsed.data.organisationSlug, parsed.data.eventId);
  if (!context.ok) return context;
  const eventId = context.event.id;

  let result: { queued: number; firstSend: boolean; } | { error: string; };
  try {
    result = await prisma.$transaction(async (tx) => {
      // Re-read under the lock: the start time is the deadline.
      const closed = await lockOpenEvent(tx, eventId);
      if (closed) return { error: closed };
      const firstSend = (await tx.attendanceCheck.count({ where: { eventId } })) === 0;
      const rsvps = await tx.rSVP.findMany({
        where: unaskedWhere(eventId),
        select: { id: true, guestEmail: true, user: { select: { email: true } } },
        orderBy: { createdAt: "asc" },
      });
      const sentAt = new Date();
      const planned = rsvps.flatMap((rsvp) => {
        const to = recipientEmail(rsvp);
        return to ? [{ rsvpId: rsvp.id, to, token: generateAttendanceToken() }] : [];
      });
      if (planned.length === 0) return { queued: 0, firstSend };
      // ON CONFLICT DO NOTHING: a registration is only ever asked once.
      await tx.attendanceCheck.createMany({
        data: planned.map((row) => ({ rsvpId: row.rsvpId, eventId, tokenHash: row.token.hash, sentAt })),
        skipDuplicates: true,
      });
      // Only rows this call inserted get an email (their digest is ours).
      const inserted = await tx.attendanceCheck.findMany({ where: { tokenHash: { in: planned.map((row) => row.token.hash) } }, select: { rsvpId: true } });
      const insertedIds = new Set(inserted.map((row) => row.rsvpId));
      const payloads: AttendanceCheckPayload[] = planned.filter((row) => insertedIds.has(row.rsvpId)).map((row) => ({ to: row.to, rsvpId: row.rsvpId, token: row.token.raw }));
      await enqueueAttendanceChecks(tx, payloads);
      return { queued: payloads.length, firstSend };
    }, { timeout: 60_000 });
  } catch {
    console.error("[attendance check] queueing failed");
    return { ok: false, error: "Could not queue the emails. Please try again." };
  }
  if ("error" in result) return { ok: false, error: result.error };
  if (result.queued === 0) return { ok: false, error: "Every confirmed guest has already been asked." };

  startOutboxWorker();
  await recordAuditEvent({
    action: ATTENDANCE_AUDIT.sent, actorUserId, organisationId: context.org.id, targetType: "Event", targetId: eventId,
    metadata: { recipientCount: result.queued, firstSend: result.firstSend },
  });
  revalidatePath(`/dashboard/${context.org.slug}/event/${eventId}`);
  return { ok: true, data: { queued: result.queued } };
}

/**
 * Remind guests who have not replied, at most once per 12 hours each. The
 * link is rotated, so only the newest email's link works (an older queued
 * email is dropped at delivery). Allowed until the event starts.
 */
export async function remindAttendanceChecksForUser(actorUserId: string | null, input: unknown): Promise<ActionResult<{ queued: number; }>> {
  if (!actorUserId) return { ok: false, error: "You must be signed in." };
  const parsed = attendanceCheckRefSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  if (await isActionRateLimited("attendanceCheckSend", actorUserId)) return { ok: false, error: TOO_MANY };
  const context = await requireAttendanceContext(actorUserId, parsed.data.organisationSlug, parsed.data.eventId);
  if (!context.ok) return context;
  const eventId = context.event.id;

  let result: { queued: number; } | { error: string; };
  try {
    result = await prisma.$transaction(async (tx) => {
      const closed = await lockOpenEvent(tx, eventId, "This event has started, so guests can no longer be reminded.");
      if (closed) return { error: closed };
      const now = new Date();
      const due = await tx.attendanceCheck.findMany({
        where: remindableWhere(eventId, now),
        select: { id: true, rsvpId: true, rsvp: { select: { guestEmail: true, user: { select: { email: true } } } } },
      });
      const planned = due.flatMap((check) => {
        const to = recipientEmail(check.rsvp);
        return to ? [{ id: check.id, rsvpId: check.rsvpId, to, token: generateAttendanceToken() }] : [];
      });
      if (planned.length === 0) return { queued: 0 };
      const threshold = new Date(now.getTime() - ATTENDANCE_REMINDER_INTERVAL_MS);
      // One statement rotates every due link; the guard re-checks "no reply, still due".
      const rotated = await tx.$queryRaw<Array<{ rsvpId: string; }>>`
        UPDATE "AttendanceCheck" AS a
        SET "tokenHash" = v."hash", "sentAt" = ${sqlUtcTimestamp(now)}, "updatedAt" = ${sqlUtcTimestamp(now)}
        FROM unnest(${planned.map((row) => row.id)}::text[], ${planned.map((row) => row.token.hash)}::text[]) AS v("id", "hash")
        WHERE a."id" = v."id" AND a."response" IS NULL AND a."sentAt" <= ${sqlUtcTimestamp(threshold)}
        RETURNING a."rsvpId"`;
      const rotatedIds = new Set(rotated.map((row) => row.rsvpId));
      const payloads: AttendanceCheckPayload[] = planned.filter((row) => rotatedIds.has(row.rsvpId)).map((row) => ({ to: row.to, rsvpId: row.rsvpId, token: row.token.raw, reminder: true }));
      await enqueueAttendanceChecks(tx, payloads);
      return { queued: payloads.length };
    }, { timeout: 60_000 });
  } catch {
    console.error("[attendance check] reminder queueing failed");
    return { ok: false, error: "Could not queue the reminders. Please try again." };
  }
  if ("error" in result) return { ok: false, error: result.error };
  if (result.queued === 0) return { ok: false, error: "No one is due a reminder. Each guest can be reminded once every 12 hours." };

  startOutboxWorker();
  await recordAuditEvent({
    action: ATTENDANCE_AUDIT.reminded, actorUserId, organisationId: context.org.id, targetType: "Event", targetId: eventId,
    metadata: { recipientCount: result.queued },
  });
  revalidatePath(`/dashboard/${context.org.slug}/event/${eventId}`);
  return { ok: true, data: { queued: result.queued } };
}

/** The release-on-decline switch. Same access as sending; audited only on change. */
export async function setAttendanceReleaseOnDeclineForUser(actorUserId: string | null, input: unknown): Promise<ActionResult<{ releaseOnDecline: boolean; }>> {
  if (!actorUserId) return { ok: false, error: "You must be signed in." };
  const parsed = attendanceCheckSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  if (await isActionRateLimited("attendanceCheckSettings", actorUserId)) return { ok: false, error: "Too many changes. Please wait a moment and try again." };
  const context = await requireAttendanceContext(actorUserId, parsed.data.organisationSlug, parsed.data.eventId);
  if (!context.ok) return context;
  const releaseOnDecline = parsed.data.releaseOnDecline;
  if (context.event.attendanceCheckReleaseOnDecline !== releaseOnDecline) {
    await prisma.event.update({ where: { id: context.event.id }, data: { attendanceCheckReleaseOnDecline: releaseOnDecline } });
    await recordAuditEvent({
      action: ATTENDANCE_AUDIT.settings, actorUserId, organisationId: context.org.id, targetType: "Event", targetId: context.event.id,
      metadata: { releaseOnDecline },
    });
    revalidatePath(`/dashboard/${context.org.slug}/event/${context.event.id}`);
  }
  return { ok: true, data: { releaseOnDecline } };
}
