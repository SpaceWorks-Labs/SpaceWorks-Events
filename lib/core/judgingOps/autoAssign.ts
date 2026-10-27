import "server-only";

/** Automatic judge assignment: preview the plan, then apply it under the Event lock if unchanged. */

import { EventPermission, JudgingStatus, Prisma, SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { isOrgAdmin } from "@/lib/permissions";
import { conflictKeysFor, listEligibleJudges, type JudgingResult } from "@/lib/core/judging";
import { conflictedPairs, judgeWorkOnSubmitted } from "@/lib/core/judging/judgeWork";
import { entrantDisplayName } from "@/lib/judgingDto";
import { pairKey, planAutoAssignment, type AssignmentPair, type AutoAssignMode } from "@/lib/judgingAssignment";
import { autoAssignInputSchema } from "@/lib/judgingProgress";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { EVENT_NOT_FOUND, fail, lockOpsEvent, ok, type OpsEvent, opsEventSelect } from "./shared";

const POOL_CHANGED = "Some of the people you picked can no longer judge this event. Refresh and try again.";
const PLAN_CHANGED = "Projects, judges or assignments changed since the preview. Preview again before applying.";
/** Shortfall rows returned with a preview (the total is always given). */
const PREVIEW_SHORTFALL_LIMIT = 50;

/** Org owners/admins and this event's JUDGE collaborators, read on `client` (inside the caller's transaction when given one). */
async function eligibleJudgeIds(client: Prisma.TransactionClient, organisationId: string, eventId: string): Promise<{ all: Set<string>; admins: Set<string> }> {
  const [admins, grants] = await Promise.all([
    client.membership.findMany({ where: { organisationId, role: { in: ["OWNER", "ADMIN"] } }, select: { userId: true, role: true } }),
    client.eventCollaborator.findMany({ where: { eventId, event: { organisationId }, permissions: { has: EventPermission.JUDGE } }, select: { userId: true } }),
  ]);
  const adminIds = new Set(admins.filter((row) => isOrgAdmin(row.role)).map((row) => row.userId));
  return { all: new Set([...adminIds, ...grants.map((row) => row.userId)]), admins: adminIds };
}

// ---------------------------------------------------------------------------
// Automatic assignment
// ---------------------------------------------------------------------------

export type AutoAssignJudgeRow = {
  userId: string;
  name: string;
  kind: "admin" | "judge";
  before: number;
  added: number;
  removed: number;
  after: number;
};

export type AutoAssignShortfallRow = { submissionId: string; title: string; entrantName: string; assigned: number; missing: number; possible: number };

export type AutoAssignPreviewDto = {
  perProject: number;
  mode: AutoAssignMode;
  /** SUBMITTED projects considered. */
  projects: number;
  /** Projects that reach the target after the plan. */
  covered: number;
  added: number;
  removed: number;
  /** Projects judges already started without an assignment that become their assignments, so they keep access. */
  adopted: number;
  judges: AutoAssignJudgeRow[];
  /** The first PREVIEW_SHORTFALL_LIMIT projects that can't reach the target, most short first. */
  shortfalls: AutoAssignShortfallRow[];
  shortfallTotal: number;
  /** Whether judges currently see every project (applying switches this off). */
  judgesSeeAll: boolean;
  /** Pass back to apply: refused when the plan changed in between. */
  fingerprint: string;
};

export type AutoAssignAppliedDto = { added: number; removed: number; adopted: number; covered: number; shortfallTotal: number; projects: number };

type ParsedAutoAssign = { perProject: number; mode: AutoAssignMode; judgeUserIds: string[]; fingerprint?: string };

function autoAssignRefusal(event: OpsEvent): string | null {
  if (event.resultsPublishedAt) return "Results are published, so assignments can't change. Unpublish the results first.";
  if (event.judgingStatus === JudgingStatus.CLOSED) return "Judging is closed. Reopen it before assigning judges.";
  return null;
}

/** Read the event's assignment state and build the plan, on `client` (the apply transaction, or the plain client for a preview). */
async function buildAutoAssignPlan(client: Prisma.TransactionClient, ctx: JudgingOrganiserContext, event: OpsEvent, input: ParsedAutoAssign) {
  const pool = [...new Set(input.judgeUserIds)];
  const eligible = await eligibleJudgeIds(client, ctx.organisationId, event.id);
  if (pool.some((id) => !eligible.all.has(id))) return { ok: false, error: POOL_CHANGED } as const;

  const submittedOnly = { eventId: event.id, status: SubmissionStatus.SUBMITTED };
  const [projects, existing, worked] = await Promise.all([
    client.submission.findMany({ where: submittedOnly, select: { id: true, teamId: true, rsvpId: true }, orderBy: { id: "asc" } }),
    client.judgeAssignment.findMany({ where: { eventId: event.id, submission: submittedOnly }, select: { id: true, judgeUserId: true, submissionId: true } }),
    // Pairs with saved scores or a review row (draft or submitted).
    judgeWorkOnSubmitted(client, event.id, { withScores: false }),
  ]);
  // Conflicts for everyone whose pairs the plan looks at: the pool, assigned judges, and judges with work on a project.
  const judgeIds = [...new Set([...pool, ...existing.map((row) => row.judgeUserId), ...worked.map((row) => row.judgeUserId)])];
  const conflicts = await conflictKeysFor(client, event.id, judgeIds);
  const blocked = conflictedPairs(projects, conflicts);
  const started = new Set(worked.map((row) => pairKey(row.judgeUserId, row.submissionId)));
  const submitted = new Set(worked.filter((row) => row.submittedAt).map((row) => pairKey(row.judgeUserId, row.submissionId)));
  const plan = planAutoAssignment({
    projectIds: projects.map((row) => row.id),
    poolJudgeIds: pool,
    perProject: input.perProject,
    mode: input.mode,
    existing: existing.map((row) => ({ judgeUserId: row.judgeUserId, submissionId: row.submissionId })),
    blocked,
    started,
    submitted,
    // Applying switches judges to "assigned projects only", so work they started while seeing every project becomes theirs.
    adoptStarted: event.judgesSeeAll,
    canJudge: (judgeUserId) => eligible.all.has(judgeUserId),
  });
  const assignmentIds = new Map(existing.map((row) => [pairKey(row.judgeUserId, row.submissionId), row.id]));
  return { ok: true, plan, projects: projects.length, admins: eligible.admins, assignmentIds } as const;
}

function parseAutoAssign(input: unknown): { ok: true; data: ParsedAutoAssign } | { ok: false; error: string; fieldErrors?: Record<string, string[]> } {
  const parsed = autoAssignInputSchema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? "form");
    const message = key === "perProject" ? "Choose between 1 and 20 judges per project." : key === "judgeUserIds" ? "Pick at least one judge." : "Invalid input.";
    fieldErrors[key] = [message];
  }
  return fail(Object.values(fieldErrors)[0]?.[0] ?? "Invalid input.", fieldErrors);
}

/**
 * Preview an automatic assignment without writing anything: per-judge loads
 * before and after, and the projects that can't reach the target.
 */
export async function previewAutoAssignment(ctx: JudgingOrganiserContext, input: unknown): Promise<JudgingResult<AutoAssignPreviewDto>> {
  const parsed = parseAutoAssign(input);
  if (!parsed.ok) return parsed;
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: opsEventSelect });
  if (!event) return fail(EVENT_NOT_FOUND);
  const refusal = autoAssignRefusal(event);
  if (refusal) return fail(refusal);
  const built = await buildAutoAssignPlan(prisma, ctx, event, parsed.data);
  if (!built.ok) return fail(built.error);
  const { plan } = built;

  const [judges, shortfallRows] = await Promise.all([
    listEligibleJudges(ctx),
    plan.shortfalls.length === 0
      ? Promise.resolve([])
      : prisma.submission.findMany({
          where: { eventId: event.id, id: { in: plan.shortfalls.slice(0, PREVIEW_SHORTFALL_LIMIT).map((row) => row.submissionId) } },
          select: { id: true, title: true, team: { select: { name: true } }, rsvp: { select: { guestName: true, user: { select: { name: true } } } } },
        }),
  ]);
  const judgeById = new Map(judges.map((judge) => [judge.userId, judge]));
  const projectById = new Map(shortfallRows.map((row) => [row.id, row]));
  const judgeRows: AutoAssignJudgeRow[] = plan.loads
    .map((load): AutoAssignJudgeRow => {
      const judge = judgeById.get(load.judgeUserId);
      return {
        userId: load.judgeUserId,
        name: judge?.name ?? "Judge",
        kind: judge?.kind ?? (built.admins.has(load.judgeUserId) ? "admin" : "judge"),
        before: load.before,
        added: load.added,
        removed: load.removed,
        after: load.after,
      };
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) || (a.userId < b.userId ? -1 : 1) : a.kind === "judge" ? -1 : 1));
  return ok({
    perProject: parsed.data.perProject,
    mode: parsed.data.mode,
    projects: built.projects,
    covered: plan.covered,
    added: plan.add.length,
    removed: plan.remove.length,
    adopted: plan.adopt.length,
    judges: judgeRows,
    shortfalls: plan.shortfalls.slice(0, PREVIEW_SHORTFALL_LIMIT).map((row) => {
      const project = projectById.get(row.submissionId);
      return { ...row, title: project?.title ?? "Project", entrantName: project ? entrantDisplayName(project) : "" };
    }),
    shortfallTotal: plan.shortfalls.length,
    judgesSeeAll: event.judgesSeeAll,
    fingerprint: plan.fingerprint,
  });
}

/**
 * Apply an automatic assignment: re-plan under the Event row lock, refuse if
 * the plan differs from the preview the organiser saw, then remove (replace
 * mode) and add assignments (including projects judges already started
 * while they could see every project), switch judges to "assigned projects only", and
 * store the target. One transaction; audited (JUDGES_AUTO_ASSIGNED).
 */
export async function applyAutoAssignment(ctx: JudgingOrganiserContext, input: unknown): Promise<JudgingResult<AutoAssignAppliedDto>> {
  const parsed = parseAutoAssign(input);
  if (!parsed.ok) return parsed;
  if (!parsed.data.fingerprint) return fail(PLAN_CHANGED);
  return prisma.$transaction(
    async (tx): Promise<JudgingResult<AutoAssignAppliedDto>> => {
      const event = await lockOpsEvent(tx, ctx);
      if (!event) return fail(EVENT_NOT_FOUND);
      const refusal = autoAssignRefusal(event);
      if (refusal) return fail(refusal);
      const built = await buildAutoAssignPlan(tx, ctx, event, parsed.data);
      if (!built.ok) return fail(built.error);
      const { plan } = built;
      if (plan.fingerprint !== parsed.data.fingerprint) return fail(PLAN_CHANGED);

      const removeIds = plan.remove.map((pair: AssignmentPair) => built.assignmentIds.get(pairKey(pair.judgeUserId, pair.submissionId))).filter((id): id is string => Boolean(id));
      if (removeIds.length) await tx.judgeAssignment.deleteMany({ where: { eventId: event.id, id: { in: removeIds } } });
      const create = [...plan.add, ...plan.adopt];
      if (create.length) {
        await tx.judgeAssignment.createMany({
          data: create.map((pair) => ({ eventId: event.id, judgeUserId: pair.judgeUserId, submissionId: pair.submissionId })),
          skipDuplicates: true,
        });
      }
      await tx.event.update({ where: { id: event.id }, data: { judgesSeeAll: false, reviewsPerProject: parsed.data.perProject } });
      await recordAuditEvent({
        client: tx,
        action: "JUDGES_AUTO_ASSIGNED",
        actorUserId: ctx.userId,
        organisationId: ctx.organisationId,
        targetType: "Event",
        targetId: event.id,
        metadata: {
          perProject: parsed.data.perProject,
          mode: parsed.data.mode,
          judges: plan.loads.length,
          projects: built.projects,
          added: plan.add.length,
          removed: removeIds.length,
          adopted: plan.adopt.length,
          shortfalls: plan.shortfalls.length,
        },
      });
      return ok({ added: plan.add.length, removed: removeIds.length, adopted: plan.adopt.length, covered: plan.covered, shortfallTotal: plan.shortfalls.length, projects: built.projects });
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
