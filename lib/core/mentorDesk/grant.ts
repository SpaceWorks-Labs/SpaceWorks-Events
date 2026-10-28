import "server-only";

/*
 * The MENTOR grant's lifecycle (docs/MENTOR_DESK.md), kept free of auth and
 * framework imports so invite acceptance and collaborator actions can call it
 * inside their own transactions. The optional crew ticket is added or removed
 * after the commit (./crewLink.ts), because the crew core runs its own
 * transaction under the Event lock.
 *
 * Fencing: a grant change locks the EventCollaborator row FOR UPDATE
 * (lockCollaborator) before it cleans up, and every mentor command reads the
 * grant FOR SHARE (liveMentor), so a command either finishes before the
 * removal or sees the grant gone.
 */

import { EventPermission, HelpRequestStatus, MentorAssignmentStatus, OfficeHourBookingStatus, Prisma } from "@prisma/client";
import { helpDeadline } from "@/lib/mentorDesk/rules";
import { OFFICE_HOUR_CANCELLED_KIND } from "@/lib/outbox/mentor";
import { notifyBooking, scheduleOf } from "./officeHourMail";
import { lockHelpRow, releaseLocked } from "./helpShared";
import { refuse } from "./shared";
import { revokeMentoringCertificatesLocked } from "@/lib/volunteer/mentoring";

/** Creates the profile for a MENTOR grant (on invite acceptance or a grant change). Idempotent. */
export async function ensureMentorProfile(tx: Prisma.TransactionClient, eventId: string, userId: string) {
  await tx.mentorProfile.upsert({ where: { eventId_userId: { eventId, userId } }, create: { eventId, userId }, update: {} });
}

/**
 * Finds a collaborator row, locks it FOR UPDATE and re-reads it, so a grant
 * change never races a mentor command holding the grant FOR SHARE.
 */
export async function lockCollaborator(tx: Prisma.TransactionClient, where: Prisma.EventCollaboratorWhereInput) {
  const found = await tx.eventCollaborator.findFirst({ where, select: { id: true } });
  if (!found) return null;
  await tx.$queryRaw`SELECT "id" FROM "EventCollaborator" WHERE "id" = ${found.id} FOR UPDATE`;
  return tx.eventCollaborator.findFirst({ where: { AND: [where, { id: found.id }] }, select: { id: true, eventId: true, userId: true, permissions: true } });
}

/** Shown when a grant removal would cut a booked office hour that is under way (shift_workflow "work_locked"). */
export const MENTOR_WORK_IN_PROGRESS = "Work is in progress: a booked office hour with this mentor has started. Try again once it ends, or cancel its booking first.";

/** Refuses removing a MENTOR grant while one of the mentor's booked office hours is under way. */
export async function requireNoMentoringInProgress(tx: Prisma.TransactionClient, eventId: string, userId: string, now = new Date()) {
  const started = await tx.officeHourSlot.findFirst({
    where: { eventId, mentorUserId: userId, cancelledAt: null, startsAt: { lte: now }, endsAt: { gt: now }, bookings: { some: { status: OfficeHourBookingStatus.BOOKED } } },
    select: { id: true },
  });
  if (started) refuse(MENTOR_WORK_IN_PROGRESS);
}

/**
 * assignment_workflow.end_role_locked: when a MENTOR grant goes, its live
 * mappings end, its claims return to the queue (or expire past their
 * deadline) under each row's lock, its future slots are cancelled (logged as
 * "role_withdrawn") with their bookings (the teams and the mentor are
 * emailed), and its visit leases end. Its round-pool places are removed,
 * except where it is a round's only pool member: deleting that row would open
 * the round to every mentor, so it stays, inert (no grant). The profile stays
 * for history.
 */
export async function endMentorRoleLocked(tx: Prisma.TransactionClient, eventId: string, userId: string, actorUserId: string) {
  const now = new Date();
  await tx.mentorTeamAssignment.updateMany({ where: { eventId, mentorUserId: userId, endedAt: null }, data: { status: MentorAssignmentStatus.ENDED, endedAt: now, version: { increment: 1 } } });
  const event = await tx.event.findUnique({ where: { id: eventId }, select: { endDateTime: true } });
  const claimed = await tx.helpRequest.findMany({ where: { eventId, claimedByUserId: userId, status: HelpRequestStatus.CLAIMED }, select: { id: true }, orderBy: { id: "asc" } });
  for (const { id } of claimed) {
    // Locked and re-read: a request resolved or released meanwhile is left as it is.
    const row = await lockHelpRow(tx, eventId, id);
    if (row.status !== HelpRequestStatus.CLAIMED || row.claimedByUserId !== userId) continue;
    const terminal = Boolean(event) && helpDeadline(row.expiresAt, event!.endDateTime).getTime() <= now.getTime();
    await releaseLocked(tx, row, { terminal, kind: "role_ended", actorUserId, now });
  }
  const slots = await tx.officeHourSlot.findMany({ where: { eventId, mentorUserId: userId, cancelledAt: null, startsAt: { gt: now } }, orderBy: { id: "asc" } });
  for (const slot of slots) {
    await tx.$queryRaw`SELECT "id" FROM "OfficeHourSlot" WHERE "id" = ${slot.id} FOR UPDATE`;
    const booked = await tx.officeHourBooking.findMany({ where: { slotId: slot.id, status: OfficeHourBookingStatus.BOOKED }, select: { id: true } });
    await tx.officeHourBooking.updateMany({ where: { id: { in: booked.map((b) => b.id) }, status: OfficeHourBookingStatus.BOOKED }, data: { status: OfficeHourBookingStatus.CANCELLED, cancelledAt: now, cancelReason: "role_withdrawn" } });
    const next = await tx.officeHourSlot.update({ where: { id: slot.id }, data: { cancelledAt: now, version: { increment: 1 } } });
    await tx.officeHourChange.create({ data: { eventId, slotId: slot.id, actorUserId, reason: "role_withdrawn", oldSchedule: scheduleOf(slot), newSchedule: scheduleOf(next) } });
    await notifyBooking(tx, booked.map((b) => b.id), OFFICE_HOUR_CANCELLED_KIND);
  }
  await tx.mentoringVisit.updateMany({ where: { eventId, mentorUserId: userId, expiresAt: { gt: now } }, data: { expiresAt: now, version: { increment: 1 } } });
  // The grant is part of the mentoring evidence: a contributor certificate resting on it alone is revoked (docs/VOLUNTEERS.md).
  await revokeMentoringCertificatesLocked(tx, eventId, userId);
  const seats = await tx.mentoringRoundMentor.findMany({ where: { mentorUserId: userId, round: { eventId } }, select: { id: true, roundId: true } });
  for (const seat of seats) {
    if ((await tx.mentoringRoundMentor.count({ where: { roundId: seat.roundId, mentorUserId: { not: userId } } })) > 0) {
      await tx.mentoringRoundMentor.delete({ where: { id: seat.id } });
    }
  }
}

/** Keeps profiles in step with a collaborator's grant change (inside the caller's transaction, the collaborator row locked). */
export async function syncMentorGrantLocked(tx: Prisma.TransactionClient, eventId: string, userId: string, before: readonly EventPermission[], after: readonly EventPermission[], actorUserId: string) {
  const had = before.includes(EventPermission.MENTOR);
  const has = after.includes(EventPermission.MENTOR);
  if (has) await ensureMentorProfile(tx, eventId, userId);
  if (had && !has) await endMentorRoleLocked(tx, eventId, userId, actorUserId);
}
