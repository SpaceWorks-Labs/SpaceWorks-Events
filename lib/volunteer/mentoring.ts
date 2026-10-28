import "server-only";

import { EventPermission, HelpRequestStatus, type Prisma } from "@prisma/client";
import type { prisma } from "@/lib/db";
import { revokeCertificatesLocked } from "./hours";

/*
 * Mentoring evidence for contributor certificates (docs/VOLUNTEERS.md,
 * docs/MENTOR_DESK.md), after the Space Works contribution proof: a crew
 * member linked to an account that still holds the event's MENTOR grant and
 * has done real mentoring work there: an assignment that was ever ACTIVE
 * (`activatedAt`), a help request they resolved, or a non-away mentoring-round
 * check-in. A crew kind or role label is never evidence.
 */

type Client = Prisma.TransactionClient | typeof prisma;

export const MENTORING_EVIDENCE_REMOVED = "mentoring_evidence_removed";

/** Of these accounts, the ones with mentoring evidence on the event. */
export async function mentoringEvidenceUserIds(client: Client, eventId: string, userIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Set();
  const grants = await client.eventCollaborator.findMany({ where: { eventId, userId: { in: ids }, permissions: { has: EventPermission.MENTOR } }, select: { userId: true } });
  const mentors = grants.map((grant) => grant.userId);
  if (mentors.length === 0) return new Set();
  const [assignments, resolved, checkIns] = await Promise.all([
    client.mentorTeamAssignment.findMany({ where: { eventId, mentorUserId: { in: mentors }, activatedAt: { not: null } }, distinct: ["mentorUserId"], select: { mentorUserId: true } }),
    client.helpRequestActivity.findMany({ where: { eventId, actorUserId: { in: mentors }, kind: "resolve", request: { status: HelpRequestStatus.RESOLVED } }, distinct: ["actorUserId"], select: { actorUserId: true } }),
    client.mentoringCheckIn.findMany({ where: { eventId, mentorUserId: { in: mentors }, away: false }, distinct: ["mentorUserId"], select: { mentorUserId: true } }),
  ]);
  return new Set([
    ...assignments.map((row) => row.mentorUserId),
    ...resolved.flatMap((row) => (row.actorUserId ? [row.actorUserId] : [])),
    ...checkIns.map((row) => row.mentorUserId),
  ]);
}

export async function hasMentoringEvidence(client: Client, eventId: string, userId: string | null): Promise<boolean> {
  return userId != null && (await mentoringEvidenceUserIds(client, eventId, [userId])).has(userId);
}

/**
 * Called when a mentor's evidence goes away (the MENTOR grant is removed,
 * inside endMentorRoleLocked): revokes the live certificates of their crew
 * places on the event that rest on mentoring alone (no verified minutes).
 * Takes the crew member row locks itself, in id order.
 */
export async function revokeMentoringCertificatesLocked(tx: Prisma.TransactionClient, eventId: string, userId: string) {
  const members = await tx.eventCrewMember.findMany({ where: { eventId, userId }, orderBy: { id: "asc" }, select: { id: true } });
  let revoked = 0;
  for (const member of members) {
    await tx.$queryRaw`SELECT "id" FROM "EventCrewMember" WHERE "id" = ${member.id} FOR UPDATE`;
    const live = await tx.contributorCertificate.count({ where: { crewMemberId: member.id, revokedAt: null, minutes: 0 } });
    // The grant is part of the evidence, so its removal always ends a mentoring-only certificate.
    if (live > 0) revoked += await revokeCertificatesLocked(tx, member.id, MENTORING_EVIDENCE_REMOVED);
  }
  return revoked;
}
