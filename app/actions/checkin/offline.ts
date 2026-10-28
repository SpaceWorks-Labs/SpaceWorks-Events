import { Prisma, type AttendanceResponse, type RsvpStatus } from "@prisma/client";
import { gateCheckInForStatus } from "@/lib/checkIn";
import { prisma } from "@/lib/db";
import { offlineCheckInRosterSchema, syncOfflineCheckInsSchema } from "@/lib/validators";
import type { ActionResult } from "../org";
import { commitCheckInProjection } from "@/lib/checkInMutations";
import { getCheckInDetails, getRegistrationDetails } from "@/lib/checkInDetails";
import { deskAttendanceState } from "@/lib/attendanceCheck";
import { attendeeLabel, requireOrgMemberForEvent, revalidatePath } from "./access";
import type { OfflineCheckInRosterRow } from "../checkin";

export async function downloadOfflineCheckInRoster(
  input: unknown,
): Promise<ActionResult<{ generatedAt: string; rows: OfflineCheckInRosterRow[]; }>> {
  const parsed = offlineCheckInRosterSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid offline roster request." };
  }

  const { organisationSlug, eventId } = parsed.data;
  const ctx = await requireOrgMemberForEvent(organisationSlug, eventId);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  // The whole roster in two set-based reads (registrations with their user
  // and team joined in SQL, then every answer of those registrations), not a
  // relation lookup per registration id.
  const rosterStatuses: RsvpStatus[] = ["CONFIRMED", "WAITLISTED", "PENDING_APPROVAL"];
  const [rsvps, answers] = await Promise.all([
    prisma.$queryRaw<
      Array<{ id: string; checkInToken: string; guestName: string | null; guestEmail: string | null; status: RsvpStatus; checkedInAt: Date | null; userId: string | null; userName: string | null; userEmail: string | null; teamName: string | null; isCrew: boolean; crewFood: string | null; attendanceResponse: AttendanceResponse | null; attendanceAsked: boolean; }>
    >`
      SELECT r."id", r."checkInToken", r."guestName", r."guestEmail", r."status", r."checkedInAt", r."userId",
        u."name" AS "userName", u."email" AS "userEmail", t."name" AS "teamName", r."isCrew", c."foodPreference" AS "crewFood",
        ac."response" AS "attendanceResponse", (ac."id" IS NOT NULL) AS "attendanceAsked"
      FROM "RSVP" r
      LEFT JOIN "User" u ON u."id" = r."userId"
      LEFT JOIN "Team" t ON t."id" = r."teamId"
      LEFT JOIN "EventCrewMember" c ON c."rsvpId" = r."id"
      LEFT JOIN "AttendanceCheck" ac ON ac."rsvpId" = r."id"
      WHERE r."eventId" = ${ctx.event.id} AND r."status"::text IN (${Prisma.join(rosterStatuses)})
      ORDER BY r."createdAt" DESC`,
    prisma.rsvpAnswer.findMany({
      where: { rsvp: { eventId: ctx.event.id, status: { in: rosterStatuses } } },
      include: { field: { select: { key: true, label: true } } },
      orderBy: { id: "asc" },
    }),
  ]);
  const answersByRsvp = new Map<string, typeof answers>();
  for (const answer of answers) {
    const list = answersByRsvp.get(answer.rsvpId);
    if (list) list.push(answer);
    else answersByRsvp.set(answer.rsvpId, [answer]);
  }

  return {
    ok: true,
    data: {
      generatedAt: new Date().toISOString(),
      rows: rsvps.map((r) => {
        const user = r.userId ? { name: r.userName, email: r.userEmail } : null;
        const rsvpAnswers = answersByRsvp.get(r.id) ?? [];
        return {
          rsvpId: r.id,
          ticketToken: r.checkInToken,
          displayName: attendeeLabel({ user, guestName: r.guestName, guestEmail: r.guestEmail }),
          email: user?.email ?? r.guestEmail,
          status: r.status,
          checkedInAt: r.checkedInAt?.toISOString() ?? null,
          checkInDetails: getCheckInDetails(rsvpAnswers, r.crewFood != null ? { foodPreference: r.crewFood } : null),
          registrationDetails: getRegistrationDetails(rsvpAnswers),
          teamName: r.teamName,
          // The attendance reply only (docs/ATTENDANCE.md); never the note.
          attendance: deskAttendanceState(r.attendanceAsked ? { response: r.attendanceResponse } : null),
          isCrew: r.isCrew,
        };
      }),
    },
  };
}

export async function syncOfflineCheckIns(
  input: unknown,
): Promise<ActionResult<{ syncedIds: string[]; alreadyCheckedInIds: string[]; failed: { rsvpId: string; error: string; }[]; }>> {
  const parsed = syncOfflineCheckInsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid offline check-in queue." };
  }

  const { organisationSlug, eventId, checkIns } = parsed.data;
  const ctx = await requireOrgMemberForEvent(organisationSlug, eventId);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  const rsvps = await prisma.rSVP.findMany({
    where: { eventId: ctx.event.id, id: { in: checkIns.map((checkIn) => checkIn.rsvpId) } },
    select: { id: true, status: true, checkedInAt: true },
  });
  const rsvpById = new Map(rsvps.map((rsvp) => [rsvp.id, rsvp]));
  const syncedIds: string[] = [];
  const alreadyCheckedInIds: string[] = [];
  const failed: { rsvpId: string; error: string; }[] = [];
  const seenRsvpIds = new Set<string>();

  for (const checkIn of checkIns) {
    if (seenRsvpIds.has(checkIn.rsvpId)) {
      failed.push({ rsvpId: checkIn.rsvpId, error: "Duplicate offline check-in entry." });
      continue;
    }
    seenRsvpIds.add(checkIn.rsvpId);
    const rsvp = rsvpById.get(checkIn.rsvpId);
    if (!rsvp) {
      failed.push({ rsvpId: checkIn.rsvpId, error: "RSVP not found for this event." });
      continue;
    }
    const gate = gateCheckInForStatus(rsvp.status, checkIn.force);
    if (!gate.ok) {
      failed.push({ rsvpId: checkIn.rsvpId, error: gate.reason });
      continue;
    }
    const checkedInAt = new Date(checkIn.checkedInAt);
    const earliest = ctx.event.startDateTime.getTime() - 24 * 60 * 60_000;
    const latest = Math.min(Date.now() + 5 * 60_000, ctx.event.endDateTime.getTime() + 60 * 60_000);
    if (checkedInAt.getTime() < earliest || checkedInAt.getTime() > latest) {
      failed.push({ rsvpId: checkIn.rsvpId, error: "Offline check-in time is outside the event operating window." });
      continue;
    }
    if (rsvp.checkedInAt) {
      alreadyCheckedInIds.push(rsvp.id);
      continue;
    }
    const committed = await commitCheckInProjection({
      rsvpId: rsvp.id,
      actorUserId: ctx.actorUserId,
      source: "offline-sync",
      checkedInAt,
      force: checkIn.force,
    });
    if (committed.state === "checked-in") {
      syncedIds.push(rsvp.id);
    } else if (committed.state === "already-checked-in") {
      alreadyCheckedInIds.push(rsvp.id);
    } else {
      const currentGate = committed.state === "ineligible" ? gateCheckInForStatus(committed.status, checkIn.force) : null;
      failed.push({
        rsvpId: rsvp.id,
        error: committed.state === "missing" ? "RSVP not found for this event." : currentGate?.ok ? "Check-in could not be completed." : currentGate!.reason,
      });
    }
  }

  if (syncedIds.length > 0) {
    revalidatePath(`/dashboard/${ctx.orgSlug}/event/${ctx.event.id}`);
    revalidatePath(`/dashboard/${ctx.orgSlug}/event/${ctx.event.id}/check-in`);
  }

  return { ok: true, data: { syncedIds, alreadyCheckedInIds, failed } };
}
