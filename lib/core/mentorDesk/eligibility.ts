import "server-only";

/*
 * policy.visit_eligible and policy.is_conflicted (docs/MENTOR_DESK.md), read
 * inside the caller's transaction. Team membership always conflicts; a
 * DECLARED or AFFILIATION conflict blocks visits, claims and assignments.
 */

import { MentorAssignmentStatus, MentoringRoundStatus, Prisma, RsvpStatus } from "@prisma/client";
import { skillAndPriorityEligible } from "@/lib/mentorDesk/rules";
import { teamMemberUserIds } from "./access";

export type HelpScope = { teamId: string | null; rsvpId: string | null };

/** The LIVE round of an event, if any: its assignments and pool apply while it runs. */
export async function liveRoundId(tx: Prisma.TransactionClient, eventId: string): Promise<string | null> {
  const round = await tx.mentoringRound.findFirst({ where: { eventId, status: MentoringRoundStatus.LIVE }, select: { id: true } });
  return round?.id ?? null;
}

/** Live assignments that count now: event-wide ones plus those of the live round. */
function activeAssignmentWhere(eventId: string, teamId: string, roundId: string | null, now: Date): Prisma.MentorTeamAssignmentWhereInput {
  return {
    eventId,
    teamId,
    status: MentorAssignmentStatus.ACTIVE,
    endedAt: null,
    activeFrom: { lte: now },
    OR: [{ roundId: null }, ...(roundId ? [{ roundId }] : [])],
  };
}

/** True when the mentor is on the team, or holds an active DECLARED/AFFILIATION conflict with it. */
export async function isBlockedForTeam(tx: Prisma.TransactionClient, eventId: string, mentorUserId: string, teamId: string): Promise<boolean> {
  const [members, conflict] = await Promise.all([
    teamMemberUserIds(tx, teamId),
    tx.mentorConflict.findFirst({ where: { eventId, mentorUserId, teamId, active: true }, select: { id: true } }),
  ]);
  return members.has(mentorUserId) || Boolean(conflict);
}

/**
 * Whether this mentor may take help from this team or registration now: only
 * a CONFIRMED team or a CONFIRMED solo registration (never a crew ticket).
 * `skillTags` empty skips the skill check; `priorityUntil` opens the
 * assigned-mentor window.
 */
export async function visitEligible(tx: Prisma.TransactionClient, params: {
  eventId: string;
  mentor: { userId: string; skills: readonly string[] };
  scope: HelpScope;
  skillTags?: readonly string[];
  priorityUntil?: Date | null;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const { teamId, rsvpId } = params.scope;
  if (rsvpId) {
    const rsvp = await tx.rSVP.findFirst({ where: { id: rsvpId, eventId: params.eventId, status: RsvpStatus.CONFIRMED, isCrew: false }, select: { userId: true } });
    if (!rsvp || rsvp.userId === params.mentor.userId) return false;
    return skillAndPriorityEligible({ assignedToMentor: false, teamHasAssignedMentor: false, priorityUntil: null, now, mentorSkills: params.mentor.skills, skillTags: params.skillTags ?? [] });
  }
  if (!teamId) return false;
  if (!(await tx.team.findFirst({ where: { id: teamId, eventId: params.eventId, status: RsvpStatus.CONFIRMED }, select: { id: true } }))) return false;
  if (await isBlockedForTeam(tx, params.eventId, params.mentor.userId, teamId)) return false;
  const roundId = await liveRoundId(tx, params.eventId);
  const assigned = await tx.mentorTeamAssignment.findMany({ where: activeAssignmentWhere(params.eventId, teamId, roundId, now), select: { mentorUserId: true } });
  return skillAndPriorityEligible({
    assignedToMentor: assigned.some((row) => row.mentorUserId === params.mentor.userId),
    teamHasAssignedMentor: assigned.length > 0,
    priorityUntil: params.priorityUntil ?? null,
    now,
    mentorSkills: params.mentor.skills,
    skillTags: params.skillTags ?? [],
  });
}

/**
 * Teams a judge must not score because of the Mentor Desk (policy.is_conflicted
 * for judging): any team they mentored (ACTIVE or ENDED assignment, in any
 * round) or hold an active conflict with. A proposal that was never activated
 * does not count. Empty while the desk is off, unless an assignment was ever
 * activated: mentoring that happened stays a conflict when the desk is
 * turned off later.
 */
export async function mentorJudgingConflicts(client: Prisma.TransactionClient, eventId: string, userIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (userIds.length === 0) return result;
  const event = await client.event.findUnique({ where: { id: eventId }, select: { mentorDeskEnabled: true } });
  if (!event) return result;
  if (!event.mentorDeskEnabled && !(await client.mentorTeamAssignment.findFirst({ where: { eventId, activatedAt: { not: null } }, select: { id: true } }))) return result;
  const ids = [...userIds];
  const [assignments, conflicts] = await Promise.all([
    client.mentorTeamAssignment.findMany({ where: { eventId, mentorUserId: { in: ids }, activatedAt: { not: null } }, select: { mentorUserId: true, teamId: true } }),
    client.mentorConflict.findMany({ where: { eventId, mentorUserId: { in: ids }, active: true }, select: { mentorUserId: true, teamId: true } }),
  ]);
  for (const row of [...assignments, ...conflicts]) {
    const set = result.get(row.mentorUserId) ?? new Set<string>();
    set.add(row.teamId);
    result.set(row.mentorUserId, set);
  }
  return result;
}
