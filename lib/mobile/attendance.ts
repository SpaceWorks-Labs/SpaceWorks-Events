import "server-only";

import { AttendanceResponse } from "@prisma/client";
import { prisma } from "@/lib/db";
import { attendanceReplyClosedReason } from "@/lib/attendanceCheck";
import { attendanceEligibleRsvpWhere } from "@/lib/attendanceEligibility";
import { isEligibleRsvp } from "@/lib/core/attendanceCheck/eligible";
import { unaskedWhere } from "@/lib/core/attendanceCheck/shared";
import { releaseFor } from "@/lib/core/attendanceCheck/release";
import { myAttendanceDtoSchema } from "@/lib/mobile/schemas";

/*
 * Attendance confirmation for /api/mobile/v1 (docs/ATTENDANCE.md). The
 * caller's own question by registration id (never the link token or its
 * digest), and the organiser counts that follow the Overview rule.
 */

/** The caller's own question for this registration, or null when the registration isn't theirs. */
export async function loadMyAttendance(userId: string, rsvpId: string) {
  if (!rsvpId || rsvpId.length > 128) return null;
  const rsvp = await prisma.rSVP.findFirst({
    where: { id: rsvpId, userId },
    select: {
      id: true,
      attendanceCheck: {
        select: { eventId: true, response: true, respondedAt: true, note: true, event: { select: { status: true, startDateTime: true, attendanceCheckReleaseOnDecline: true } } },
      },
    },
  });
  if (!rsvp) return null;
  const check = rsvp.attendanceCheck;
  if (!check) return myAttendanceDtoSchema.parse({ attendance: null });
  const eligible = await isEligibleRsvp(prisma, rsvp.id, check.eventId);
  const closed = attendanceReplyClosedReason({ eligible, eventStart: check.event.startDateTime, eventStatus: check.event.status });
  const release = closed ? null : await releaseFor(rsvp.id, check.event.attendanceCheckReleaseOnDecline);
  return myAttendanceDtoSchema.parse({
    attendance: {
      response: check.response,
      respondedAt: check.respondedAt?.toISOString() ?? null,
      note: check.note ?? "",
      closed,
      releaseKind: release?.kind ?? null,
      releaseRefund: release?.refund ?? null,
    },
  });
}

/**
 * Reply counts per event (the Emails card's rules), for events whose viewer
 * may email guests. An event nobody was asked about is left out (null).
 */
export async function loadAttendanceCounts(eventIds: string[]) {
  const result = new Map<string, { coming: number; notComing: number; noReply: number; notAsked: number; }>();
  if (eventIds.length === 0) return result;
  const [replies, noReply] = await Promise.all([
    prisma.attendanceCheck.groupBy({ by: ["eventId", "response"], where: { eventId: { in: eventIds }, response: { not: null } }, _count: { _all: true } }),
    prisma.attendanceCheck.groupBy({ by: ["eventId"], where: { eventId: { in: eventIds }, response: null, rsvp: attendanceEligibleRsvpWhere() }, _count: { _all: true } }),
  ]);
  const asked = new Set([...replies.map((row) => row.eventId), ...noReply.map((row) => row.eventId)]);
  for (const eventId of asked) {
    const of = (response: AttendanceResponse) => replies.find((row) => row.eventId === eventId && row.response === response)?._count._all ?? 0;
    const notAsked = await prisma.rSVP.count({ where: unaskedWhere(eventId) });
    result.set(eventId, { coming: of(AttendanceResponse.ATTENDING), notComing: of(AttendanceResponse.NOT_ATTENDING), noReply: noReply.find((row) => row.eventId === eventId)?._count._all ?? 0, notAsked });
  }
  return result;
}
