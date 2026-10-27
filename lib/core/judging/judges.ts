import "server-only";

/** Judges: eligibility, conflicts of interest, the eligible list, and manual assignment. */

import { EventPermission, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isOrgAdmin } from "@/lib/permissions";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { judgeAssignmentSchema } from "@/lib/validators";
import { fail, type JudgingResult, NOT_FOUND, okEmpty, withOrganiserLock } from "./shared";
import { mentorJudgingConflicts } from "@/lib/core/mentorDesk/eligibility";

// ---------------------------------------------------------------------------
// Judges: eligibility, assignment, conflict of interest
// ---------------------------------------------------------------------------

/** Org OWNER/ADMIN or a JUDGE collaborator on this event, read inside the caller's transaction. */
export async function isEligibleJudge(tx: Prisma.TransactionClient, organisationId: string, eventId: string, userId: string): Promise<boolean> {
  const [membership, grant] = await Promise.all([
    tx.membership.findUnique({ where: { userId_organisationId: { userId, organisationId } }, select: { role: true } }),
    tx.eventCollaborator.findFirst({ where: { eventId, userId, permissions: { has: EventPermission.JUDGE } }, select: { id: true } }),
  ]);
  return Boolean((membership && isOrgAdmin(membership.role)) || grant);
}

export type ConflictKeys = { rsvpIds: Set<string>; teamIds: Set<string> };

/**
 * The single conflict-of-interest rule: entrants the judge's own account is
 * registered on, and, when the event's Mentor Desk is on, teams the judge
 * mentored (an ACTIVE or ENDED assignment) or holds a mentor conflict with
 * (docs/MENTOR_DESK.md, `mentorJudgingConflicts`).
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

/** Assign one submission to one judge. Refused for ineligible judges and conflicts of interest. */
export async function assignJudge(ctx: JudgingOrganiserContext, input: unknown): Promise<JudgingResult> {
  const parsed = judgeAssignmentSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input.");
  return withOrganiserLock(ctx, async (tx, event) => {
    const submission = await tx.submission.findFirst({ where: { id: parsed.data.submissionId, eventId: event.id }, select: { id: true, teamId: true, rsvpId: true } });
    if (!submission) return fail(NOT_FOUND);
    if (!(await isEligibleJudge(tx, event.organisationId, event.id, parsed.data.judgeUserId))) return fail("This person is not a judge for this event.");
    const conflicts = await conflictKeysFor(tx, event.id, [parsed.data.judgeUserId]);
    if (hasConflictOfInterest(submission, conflicts.get(parsed.data.judgeUserId))) return fail("This judge is registered on this entry, so they can't judge it.");
    await tx.judgeAssignment.createMany({
      data: [{ eventId: event.id, judgeUserId: parsed.data.judgeUserId, submissionId: submission.id }],
      skipDuplicates: true,
    });
    return okEmpty();
  });
}

export async function unassignJudge(ctx: JudgingOrganiserContext, input: unknown): Promise<JudgingResult> {
  const parsed = judgeAssignmentSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input.");
  return withOrganiserLock(ctx, async (tx, event) => {
    await tx.judgeAssignment.deleteMany({ where: { eventId: event.id, judgeUserId: parsed.data.judgeUserId, submissionId: parsed.data.submissionId } });
    return okEmpty();
  });
}
