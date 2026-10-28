import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { MAX_ENTRY_MINUTES, countedMinutes } from "./math";
import { SECOND_PERSON, fail, isVolunteerSelf, lockCrewMember, reasonSchema, type VolunteerResult, type VolunteerStaff } from "./shared";

/*
 * Hours verification (docs/VOLUNTEERS.md), after the Space Works design:
 * hours are PENDING at check-out, an owner or admin who is not the volunteer
 * verifies them (VERIFIED, minutes recomputed from the attendance) and may
 * later adjust them (ADJUSTED, bounded minutes and a reason). Each change is
 * an append-only VolunteerHoursEntry; the database refuses a change without
 * one and an entry by the volunteer. Any change revokes an issued
 * contributor certificate, because its minutes no longer match.
 */

export const HOURS_CHANGED = "hours_changed";

/** Revokes the crew member's live certificate. Callers hold the crew member lock. */
export async function revokeCertificatesLocked(tx: Prisma.TransactionClient, crewMemberId: string, reason: string, now = new Date()) {
  const revoked = await tx.contributorCertificate.updateMany({ where: { crewMemberId, revokedAt: null }, data: { revokedAt: now, revokedReason: reason } });
  return revoked.count;
}

type Change = { kind: "verify" } | { kind: "adjust"; minutes: unknown; reason: unknown };

async function changeHours(staff: VolunteerStaff, hoursId: string, change: Change, now: Date): Promise<VolunteerResult<{ minutes: number; revokedCertificate: boolean }>> {
  if (!staff.isAdmin) return fail("Only organisation owners and admins can verify hours.");
  let adjusted: { minutes: number; reason: string } | null = null;
  if (change.kind === "adjust") {
    const reason = reasonSchema.safeParse(change.reason);
    if (typeof change.minutes !== "number" || !Number.isInteger(change.minutes) || change.minutes < 0 || change.minutes > MAX_ENTRY_MINUTES) return fail(`Enter whole minutes from 0 to ${MAX_ENTRY_MINUTES}.`);
    if (!reason.success) return fail("Give a reason for the adjustment.");
    adjusted = { minutes: change.minutes, reason: reason.data };
  }
  return prisma.$transaction(async (tx): Promise<VolunteerResult<{ minutes: number; revokedCertificate: boolean }>> => {
    const row = await tx.volunteerHours.findFirst({
      where: { id: hoursId, eventId: staff.eventId, signup: { shift: { event: { organisationId: staff.organisationId } } } },
      select: { signup: { select: { crewMemberId: true } } },
    });
    if (!row) return fail("Hours not found.");
    const member = await lockCrewMember(tx, staff.eventId, row.signup.crewMemberId);
    if (!member) return fail("Hours not found.");
    if (await isVolunteerSelf(tx, staff.userId, member)) return fail(SECOND_PERSON);
    await tx.$queryRaw`SELECT "id" FROM "VolunteerHours" WHERE "id" = ${hoursId} FOR UPDATE`;
    const hours = await tx.volunteerHours.findUniqueOrThrow({ where: { id: hoursId }, include: { signup: true } });
    const { signup } = hours;
    if (signup.attendance !== "CHECKED_OUT" || !signup.checkedInAt || !signup.checkedOutAt) return fail("These hours have no completed attendance.");
    let minutes: number;
    if (change.kind === "verify") {
      if (hours.state !== "PENDING") return fail("These hours are already verified. Adjust them instead.");
      const counted = countedMinutes(signup.checkedInAt, signup.checkedOutAt, signup.breakMinutes);
      if (counted == null || counted > MAX_ENTRY_MINUTES) return fail("Check the attendance times.");
      minutes = counted;
    } else {
      if (hours.state === "PENDING") return fail("Verify these hours before adjusting them.");
      minutes = adjusted!.minutes;
    }
    const state = change.kind === "verify" ? "VERIFIED" : "ADJUSTED";
    await tx.volunteerHoursEntry.create({ data: { eventId: staff.eventId, hoursId, actorUserId: staff.userId, previousVersion: hours.version, minutes, kind: state, reason: adjusted?.reason ?? "" } });
    await tx.volunteerHours.update({ where: { id: hoursId }, data: { minutes, state, version: hours.version + 1 } });
    const revoked = await revokeCertificatesLocked(tx, member.id, HOURS_CHANGED, now);
    return { ok: true, data: { minutes, revokedCertificate: revoked > 0 } };
  });
}

export function verifyHours(staff: VolunteerStaff, hoursId: string, now = new Date()) {
  return changeHours(staff, hoursId, { kind: "verify" }, now);
}

export function adjustHours(staff: VolunteerStaff, hoursId: string, minutes: unknown, reason: unknown, now = new Date()) {
  return changeHours(staff, hoursId, { kind: "adjust", minutes, reason }, now);
}

/**
 * A crew member's verified minutes: VERIFIED or ADJUSTED hours of completed
 * attendance. Pending hours never count.
 */
export async function verifiedMinutes(client: Prisma.TransactionClient | typeof prisma, crewMemberId: string): Promise<number> {
  const total = await client.volunteerHours.aggregate({
    where: { state: { in: ["VERIFIED", "ADJUSTED"] }, signup: { crewMemberId, attendance: "CHECKED_OUT" } },
    _sum: { minutes: true },
  });
  return total._sum.minutes ?? 0;
}
