import "server-only";

import { AttendanceResponse, EventStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { attendanceCheckRefSchema } from "@/lib/validators";
import type { ActionResult } from "@/app/actions/org";
import { attendanceCheckOpen, type AttendanceSummary } from "@/lib/attendanceCheck";
import { ATTENDANCE_AUDIT, CANCELLED_ERROR, STARTED_ERROR, noReplyWhere, remindableWhere, requireAttendanceContext, unaskedWhere } from "./shared";

export type AttendanceCheckStatus = AttendanceSummary & {
  releaseOnDecline: boolean;
  lastSent: { at: string; byName: string | null; recipientCount: number | null; } | null;
};

/**
 * Counts for the Emails card. Callers have already authorised the viewer for
 * the event (owners and admins). Names of the sender only, never guests'
 * names or emails.
 */
export async function loadAttendanceCheckStatus(event: { id: string; organisationId: string; attendanceCheckReleaseOnDecline: boolean; }, now: Date = new Date()): Promise<AttendanceCheckStatus> {
  const [coming, notComing, noReply, notAsked, remindable, released, last] = await Promise.all([
    prisma.attendanceCheck.count({ where: { eventId: event.id, response: AttendanceResponse.ATTENDING } }),
    prisma.attendanceCheck.count({ where: { eventId: event.id, response: AttendanceResponse.NOT_ATTENDING } }),
    prisma.attendanceCheck.count({ where: noReplyWhere(event.id) }),
    prisma.rSVP.count({ where: unaskedWhere(event.id) }),
    prisma.attendanceCheck.count({ where: remindableWhere(event.id, now) }),
    prisma.auditEvent.count({ where: { organisationId: event.organisationId, action: ATTENDANCE_AUDIT.released, targetType: "Event", targetId: event.id } }),
    prisma.auditEvent.findFirst({
      where: { organisationId: event.organisationId, action: { in: [ATTENDANCE_AUDIT.sent, ATTENDANCE_AUDIT.reminded] }, targetType: "Event", targetId: event.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, metadata: true, actor: { select: { name: true } } },
    }),
  ]);
  const metadata = last?.metadata && typeof last.metadata === "object" && !Array.isArray(last.metadata) ? (last.metadata as Record<string, unknown>) : null;
  return {
    asked: coming + notComing + noReply,
    coming,
    notComing,
    noReply,
    notAsked,
    remindable,
    released,
    releaseOnDecline: event.attendanceCheckReleaseOnDecline,
    lastSent: last
      ? {
          at: last.createdAt.toISOString(),
          byName: last.actor?.name?.trim() || null,
          recipientCount: typeof metadata?.recipientCount === "number" ? metadata.recipientCount : null,
        }
      : null,
  };
}

/**
 * The Overview readiness line (viewers who may email guests only). Counts
 * only, with the Emails card's rules; null until someone was asked.
 */
export async function loadAttendanceReplyCounts(eventId: string): Promise<{ coming: number; notComing: number; noReply: number; } | null> {
  const [coming, notComing, noReply] = await Promise.all([
    prisma.attendanceCheck.count({ where: { eventId, response: AttendanceResponse.ATTENDING } }),
    prisma.attendanceCheck.count({ where: { eventId, response: AttendanceResponse.NOT_ATTENDING } }),
    prisma.attendanceCheck.count({ where: noReplyWhere(eventId) }),
  ]);
  return coming + notComing + noReply > 0 ? { coming, notComing, noReply } : null;
}

/** The confirmation step: how many guests a send would ask right now. Read-only. */
export async function previewAttendanceCheckSendForUser(actorUserId: string | null, input: unknown): Promise<ActionResult<{ count: number; firstSend: boolean; eventStart: string; }>> {
  if (!actorUserId) return { ok: false, error: "You must be signed in." };
  const parsed = attendanceCheckRefSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const context = await requireAttendanceContext(actorUserId, parsed.data.organisationSlug, parsed.data.eventId);
  if (!context.ok) return context;
  if (context.event.status === EventStatus.CANCELLED) return { ok: false, error: CANCELLED_ERROR };
  if (!attendanceCheckOpen(context.event.startDateTime)) return { ok: false, error: STARTED_ERROR };
  const [count, asked] = await Promise.all([
    prisma.rSVP.count({ where: unaskedWhere(context.event.id) }),
    prisma.attendanceCheck.count({ where: { eventId: context.event.id } }),
  ]);
  return { ok: true, data: { count, firstSend: asked === 0, eventStart: context.event.startDateTime.toISOString() } };
}
