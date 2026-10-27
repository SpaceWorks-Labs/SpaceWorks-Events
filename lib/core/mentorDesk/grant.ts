import "server-only";

/*
 * The MENTOR grant's lifecycle (docs/MENTOR_DESK.md), kept free of auth and
 * framework imports so invite acceptance and collaborator actions can call it
 * inside their own transactions. Crew hook: after feat/event-crew merges, a
 * mentor's crew ticket is linked or unlinked in syncMentorGrantLocked.
 */

import { EventPermission, MentorAssignmentStatus, OfficeHourBookingStatus, Prisma } from "@prisma/client";

/** Creates the profile for a MENTOR grant (on invite acceptance or a grant change). Idempotent. */
export async function ensureMentorProfile(tx: Prisma.TransactionClient, eventId: string, userId: string) {
  await tx.mentorProfile.upsert({ where: { eventId_userId: { eventId, userId } }, create: { eventId, userId }, update: {} });
}

/**
 * assignment_workflow.end_role_locked: when a MENTOR grant goes, its live
 * mappings end, its claims return to the queue and its future bookings are
 * cancelled. The profile stays for history.
 */
export async function endMentorRoleLocked(tx: Prisma.TransactionClient, eventId: string, userId: string, actorUserId: string) {
  const now = new Date();
  await tx.mentorTeamAssignment.updateMany({ where: { eventId, mentorUserId: userId, endedAt: null }, data: { status: MentorAssignmentStatus.ENDED, endedAt: now, version: { increment: 1 } } });
  const claimed = await tx.helpRequest.findMany({ where: { eventId, claimedByUserId: userId, status: "CLAIMED" }, select: { id: true, openGeneration: true } });
  for (const row of claimed) {
    await tx.helpRequest.update({ where: { id: row.id }, data: { status: "OPEN", claimedByUserId: null, claimId: null, claimExpiresAt: null, lastOpenedAt: now, openGeneration: row.openGeneration + 1, version: { increment: 1 } } });
    await tx.helpRequestActivity.create({ data: { requestId: row.id, eventId, actorUserId, kind: "role_ended" } });
  }
  await tx.officeHourBooking.updateMany({ where: { eventId, status: OfficeHourBookingStatus.BOOKED, slot: { mentorUserId: userId, startsAt: { gt: now } } }, data: { status: OfficeHourBookingStatus.CANCELLED, cancelledAt: now, cancelReason: "role_withdrawn" } });
}

/** Keeps profiles in step with a collaborator's grant change (inside the caller's transaction). */
export async function syncMentorGrantLocked(tx: Prisma.TransactionClient, eventId: string, userId: string, before: readonly EventPermission[], after: readonly EventPermission[], actorUserId: string) {
  const had = before.includes(EventPermission.MENTOR);
  const has = after.includes(EventPermission.MENTOR);
  if (has) await ensureMentorProfile(tx, eventId, userId);
  if (had && !has) await endMentorRoleLocked(tx, eventId, userId, actorUserId);
}

