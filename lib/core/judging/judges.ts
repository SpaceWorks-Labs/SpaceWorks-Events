import "server-only";

/** Judges: eligibility, conflicts of interest, the eligible list, and manual assignment. */

import { EventPermission, JudgingRoundEntrySource, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isOrgAdmin } from "@/lib/permissions";
import { staffMfaSatisfied } from "@/lib/staffMfa";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { judgeAssignmentSchema } from "@/lib/validators";
import { fail, type JudgingEvent, type JudgingResult, NOT_FOUND, okEmpty, withOrganiserLock } from "./shared";
import { type JudgingRoundScope, onRoundPanel, resolveJudgingRound } from "./rounds/scope";
import { ensureJudgingRound } from "./rounds/sync";
import { freshEyesBlockedPairs } from "./rounds/freshEyes";
import { pairKey } from "@/lib/judgingAssignment";
import { recordManualAssignment } from "@/lib/core/judgingOps/assignmentRun";
import { mentorJudgingConflicts } from "@/lib/core/mentorDesk/eligibility";

export const ROUND_NOT_FOUND = "Judging round not found.";

// ---------------------------------------------------------------------------
// Judges: eligibility, assignment, conflict of interest
// ---------------------------------------------------------------------------

/**
 * Org OWNER/ADMIN or a JUDGE collaborator on this event, read inside the
 * caller's transaction, and past the staff authenticator check when this is
 * the person acting (`staffMfaSatisfied` never holds back a check about
 * someone else, such as the judge an organiser assigns). Fails closed, so a
 * core re-check refuses a judge whose session owes the check.
 */
export async function isEligibleJudge(tx: Prisma.TransactionClient, organisationId: string, eventId: string, userId: string): Promise<boolean> {
  const [membership, grant] = await Promise.all([
    tx.membership.findUnique({ where: { userId_organisationId: { userId, organisationId } }, select: { role: true } }),
    tx.eventCollaborator.findFirst({ where: { eventId, userId, permissions: { has: EventPermission.JUDGE } }, select: { id: true } }),
  ]);
  if (!(membership && isOrgAdmin(membership.role)) && !grant) return false;
  return staffMfaSatisfied(userId);
}

export type ConflictKeys = { rsvpIds: Set<string>; teamIds: Set<string> };

/**
 * Conflicts of interest, per judge: the registrations (and their teams) the
 * judge's own account owns on this event; those entrants are off limits in
 * every round. This is the one place conflicts are decided: every visibility,
 * scoring, assignment, progress and results path asks it, so a new conflict
 * source is added here only. With the Mentor Desk on (docs/MENTOR_DESK.md),
 * teams the judge mentored (an activated assignment) or holds a mentor
 * conflict with are conflicts too (`mentorJudgingConflicts`), in every round.
 */
export async function conflictKeysFor(tx: Prisma.TransactionClient, eventId: string, userIds: string[]): Promise<Map<string, ConflictKeys>> {
  const result = new Map<string, ConflictKeys>(userIds.map((id) => [id, { rsvpIds: new Set<string>(), teamIds: new Set<string>() }]));
  if (userIds.length === 0) return result;
  const [rows, mentored] = await Promise.all([
    tx.rSVP.findMany({ where: { eventId, userId: { in: userIds } }, select: { id: true, teamId: true, userId: true } }),
    mentorJudgingConflicts(tx, eventId, userIds),
  ]);
  for (const row of rows) {
    const keys = row.userId ? result.get(row.userId) : undefined;
    if (!keys) continue;
    keys.rsvpIds.add(row.id);
    if (row.teamId) keys.teamIds.add(row.teamId);
  }
  for (const [userId, teamIds] of mentored) {
    for (const teamId of teamIds) result.get(userId)?.teamIds.add(teamId);
  }
  return result;
}

/** True when the judge's own account owns an RSVP on this entrant. */
export function hasConflictOfInterest(submission: { teamId: string | null; rsvpId: string | null }, keys: ConflictKeys | undefined): boolean {
  if (!keys) return false;
  return Boolean((submission.teamId && keys.teamIds.has(submission.teamId)) || (submission.rsvpId && keys.rsvpIds.has(submission.rsvpId)));
}

export type EligibleJudgeDto = { userId: string; name: string; email: string | null; kind: "admin" | "judge" };

/** Organisation owners/admins and this event's JUDGE collaborators (organiser view). */
export async function listEligibleJudges(ctx: JudgingOrganiserContext): Promise<EligibleJudgeDto[]> {
  const [admins, grants] = await Promise.all([
    prisma.membership.findMany({
      where: { organisationId: ctx.organisationId, role: { in: ["OWNER", "ADMIN"] } },
      select: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.eventCollaborator.findMany({
      where: { eventId: ctx.eventId, event: { organisationId: ctx.organisationId }, permissions: { has: EventPermission.JUDGE } },
      select: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const seen = new Map<string, EligibleJudgeDto>();
  for (const grant of grants) seen.set(grant.user.id, { userId: grant.user.id, name: grant.user.name?.trim() || "Judge", email: grant.user.email, kind: "judge" });
  for (const admin of admins) {
    if (!seen.has(admin.user.id)) seen.set(admin.user.id, { userId: admin.user.id, name: admin.user.name?.trim() || "Organiser", email: admin.user.email, kind: "admin" });
  }
  return [...seen.values()];
}

/**
 * Everyone who can judge one round, for organiser views: the event's judges
 * (see listEligibleJudges), narrowed to the round's panel when it has one.
 */
export async function listRoundJudges(ctx: JudgingOrganiserContext, round: Pick<JudgingRoundScope, "panelUserIds">): Promise<EligibleJudgeDto[]> {
  const judges = await listEligibleJudges(ctx);
  return round.panelUserIds ? judges.filter((judge) => onRoundPanel(round, judge.userId)) : judges;
}

/** An eligible judge for the event who is also on this round's panel (when it has one). */
export async function isRoundJudge(tx: Prisma.TransactionClient, round: Pick<JudgingRoundScope, "eventId" | "panelUserIds">, organisationId: string, userId: string): Promise<boolean> {
  return onRoundPanel(round, userId) && isEligibleJudge(tx, organisationId, round.eventId, userId);
}

/** The round an organiser's assignment change is about: `roundId`, else the current round (created when the event has none). */
async function assignmentRound(tx: Prisma.TransactionClient, event: JudgingEvent, roundId: string | undefined): Promise<JudgingRoundScope | null> {
  return roundId ? resolveJudgingRound(tx, event, roundId) : ensureJudgingRound(tx, event);
}

/**
 * Assign one submission to one judge in a round (the current one unless
 * `options.roundId`). Refused for ineligible judges, judges off the round's
 * panel, projects outside an ADVANCED round, and conflicts of interest.
 */
export async function assignJudge(ctx: JudgingOrganiserContext, input: unknown, options: { roundId?: string } = {}): Promise<JudgingResult> {
  const parsed = judgeAssignmentSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input.");
  return withOrganiserLock(ctx, async (tx, event) => {
    const round = await assignmentRound(tx, event, options.roundId);
    if (!round?.id) return fail(ROUND_NOT_FOUND);
    const submission = await tx.submission.findFirst({ where: { id: parsed.data.submissionId, eventId: event.id }, select: { id: true, teamId: true, rsvpId: true } });
    if (!submission) return fail(NOT_FOUND);
    if (round.entrySource === JudgingRoundEntrySource.ADVANCED && !(await tx.judgingRoundEntry.findFirst({ where: { roundId: round.id, submissionId: submission.id }, select: { id: true } }))) {
      return fail("This project isn't in this round.");
    }
    if (!(await isRoundJudge(tx, round, event.organisationId, parsed.data.judgeUserId))) return fail("This person is not a judge for this event.");
    const conflicts = await conflictKeysFor(tx, event.id, [parsed.data.judgeUserId]);
    if (hasConflictOfInterest(submission, conflicts.get(parsed.data.judgeUserId))) return fail("This judge is registered on this entry, so they can't judge it.");
    if ((await freshEyesBlockedPairs(tx, round)).has(pairKey(parsed.data.judgeUserId, submission.id))) {
      return fail("This judge reviewed this project in an earlier round, and this round uses fresh eyes.");
    }
    const created = await tx.judgeAssignment.createMany({
      data: [{ eventId: event.id, roundId: round.id, judgeUserId: parsed.data.judgeUserId, submissionId: submission.id }],
      skipDuplicates: true,
    });
    if (created.count > 0) await recordManualAssignment(tx, ctx, { action: "JUDGE_ASSIGNED", roundId: round.id, roundPosition: round.position, judgeUserId: parsed.data.judgeUserId, submissionId: submission.id });
    return okEmpty();
  });
}

export async function unassignJudge(ctx: JudgingOrganiserContext, input: unknown, options: { roundId?: string } = {}): Promise<JudgingResult> {
  const parsed = judgeAssignmentSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input.");
  return withOrganiserLock(ctx, async (tx, event) => {
    const round = options.roundId ? await resolveJudgingRound(tx, event, options.roundId) : await resolveJudgingRound(tx, event);
    if (!round?.id) return round ? okEmpty() : fail(ROUND_NOT_FOUND);
    const removed = await tx.judgeAssignment.deleteMany({ where: { eventId: event.id, roundId: round.id, judgeUserId: parsed.data.judgeUserId, submissionId: parsed.data.submissionId } });
    if (removed.count > 0) await recordManualAssignment(tx, ctx, { action: "JUDGE_UNASSIGNED", roundId: round.id, roundPosition: round.position, judgeUserId: parsed.data.judgeUserId, submissionId: parsed.data.submissionId });
    return okEmpty();
  });
}
