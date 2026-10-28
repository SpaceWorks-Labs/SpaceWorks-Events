import "server-only";

/** The judging Progress dashboard: build the whole model, then page each list. */

import { prisma } from "@/lib/db";
import { conflictKeysFor, type ConflictKeys, type EligibleJudgeDto } from "@/lib/core/judging";
import { listRoundJudges } from "@/lib/core/judging/judges";
import { conflictedPairs, judgeWorkOnSubmitted } from "@/lib/core/judging/judgeWork";
import { judgingStatusFor, resolveJudgingRound, roundProjectsWhere } from "@/lib/core/judging/rounds/scope";
import { freshEyesBlockedPairs } from "@/lib/core/judging/rounds/freshEyes";
import { entrantDisplayName } from "@/lib/judgingDto";
import { judgeWeightedPercent } from "@/lib/judgingScore";
import { pairKey } from "@/lib/judgingAssignment";
import { numberedPage } from "@/lib/judgingOrganiserPaging";
import {
  completionPercent,
  effectiveReviewTarget,
  findOutliers,
  isStaleReview,
  JUDGING_PROGRESS_PAGE_SIZE,
  judgingProgressQuerySchema,
  type JudgingProgressSection,
} from "@/lib/judgingProgress";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { opsEventSelect } from "./shared";
import type {
  JudgingProgressDto,
  JudgingProgressSectionDto,
  JudgingProgressSummary,
  ProgressBelowTargetRow,
  ProgressJudgeRow,
  ProgressOutlierRow,
  ProgressStaleRow,
} from "./progressTypes";

// ---------------------------------------------------------------------------
// Progress dashboard
// ---------------------------------------------------------------------------

type ProgressModel = {
  summary: JudgingProgressSummary;
  belowTarget: ProgressBelowTargetRow[];
  judges: ProgressJudgeRow[];
  outliers: ProgressOutlierRow[];
  stale: ProgressStaleRow[];
};

/**
 * Compute the whole Progress model for one round of the event (the current
 * round unless `roundId`; bounded by its own projects, judges and reviews,
 * as the results table is). Counted reviews, conflicts of interest and
 * eligibility follow `loadJudgingResults`.
 */
async function buildProgressModel(ctx: JudgingOrganiserContext, now: Date, roundId?: string | null): Promise<ProgressModel | null> {
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: opsEventSelect });
  if (!event) return null;
  const round = await resolveJudgingRound(prisma, event, roundId);
  if (!round) return null;
  const submittedOnly = roundProjectsWhere(round);
  const [projects, criteria, eligible, pairs, assignments] = await Promise.all([
    prisma.submission.findMany({
      where: submittedOnly,
      select: { id: true, title: true, teamId: true, rsvpId: true, team: { select: { name: true } }, rsvp: { select: { guestName: true, user: { select: { name: true } } } } },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
    }),
    prisma.judgingCriterion.findMany({ where: { eventId: event.id, roundId: round.id }, select: { id: true, weight: true, maxScore: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] }),
    listRoundJudges(ctx, round),
    // One row per (judge, project) with work, scores aggregated in SQL.
    judgeWorkOnSubmitted(prisma, round, { withScores: true }),
    prisma.judgeAssignment.findMany({ where: { eventId: event.id, roundId: round.id, submission: submittedOnly }, select: { submissionId: true, judgeUserId: true } }),
  ]);
  const judgeById = new Map<string, EligibleJudgeDto>(eligible.map((judge) => [judge.userId, judge]));
  const conflicts: Map<string, ConflictKeys> = await conflictKeysFor(prisma, event.id, [...judgeById.keys()]);
  // Pairs a judge may not take: conflicts of interest, and earlier-round reviews when the round has fresh eyes on.
  const conflicted = conflictedPairs(projects, conflicts);
  const projectById = new Map(projects.map((row) => [row.id, row]));
  for (const key of await freshEyesBlockedPairs(prisma, round)) if (projectById.has(key.slice(key.indexOf("\u0000") + 1))) conflicted.add(key);
  // A pair counts only when the judge can still judge the event and has no conflict with that entrant.
  const valid = (judgeUserId: string, submissionId: string) =>
    projectById.has(submissionId) && judgeById.has(judgeUserId) && !conflicted.has(pairKey(judgeUserId, submissionId));

  const submittedPairs = new Set<string>();
  const scoresByPair = new Map<string, ReadonlyMap<string, number>>();
  for (const pair of pairs) {
    if (!pair.submittedAt || !valid(pair.judgeUserId, pair.submissionId)) continue;
    const key = pairKey(pair.judgeUserId, pair.submissionId);
    submittedPairs.add(key);
    scoresByPair.set(key, pair.scores);
  }

  // Saved scores without a submitted review: in progress (and stale once old).
  type Started = { judgeUserId: string; submissionId: string; scored: number; lastSavedAt: Date };
  const startedPairs = new Map<string, Started>();
  for (const pair of pairs) {
    const key = pairKey(pair.judgeUserId, pair.submissionId);
    if (pair.scored === 0 || !pair.lastSavedAt || submittedPairs.has(key) || !valid(pair.judgeUserId, pair.submissionId)) continue;
    startedPairs.set(key, { judgeUserId: pair.judgeUserId, submissionId: pair.submissionId, scored: pair.scored, lastSavedAt: pair.lastSavedAt });
  }

  const validAssignments = assignments.filter((row) => valid(row.judgeUserId, row.submissionId));
  const target = effectiveReviewTarget(round.reviewsPerProject);

  // Per project.
  const reviewsByProject = new Map<string, string[]>();
  for (const key of submittedPairs) {
    const [judgeUserId, submissionId] = key.split("\u0000") as [string, string];
    const judges = reviewsByProject.get(submissionId);
    if (judges) judges.push(judgeUserId);
    else reviewsByProject.set(submissionId, [judgeUserId]);
  }
  const startedByProject = new Map<string, number>();
  for (const entry of startedPairs.values()) startedByProject.set(entry.submissionId, (startedByProject.get(entry.submissionId) ?? 0) + 1);
  const assignedByProject = new Map<string, number>();
  for (const row of validAssignments) assignedByProject.set(row.submissionId, (assignedByProject.get(row.submissionId) ?? 0) + 1);

  let towardsTarget = 0;
  const belowTarget: ProgressBelowTargetRow[] = [];
  const outliers: ProgressOutlierRow[] = [];
  for (const project of projects) {
    const judges = reviewsByProject.get(project.id) ?? [];
    towardsTarget += Math.min(judges.length, target);
    if (judges.length < target) {
      belowTarget.push({
        submissionId: project.id,
        title: project.title,
        entrantName: entrantDisplayName(project),
        reviews: judges.length,
        inProgress: startedByProject.get(project.id) ?? 0,
        assigned: assignedByProject.get(project.id) ?? 0,
        missing: target - judges.length,
      });
    }
    const percents = judges
      .map((judgeUserId) => ({ judgeUserId, percent: judgeWeightedPercent(criteria, (criterionId) => scoresByPair.get(pairKey(judgeUserId, project.id))?.get(criterionId)) }))
      .filter((entry): entry is { judgeUserId: string; percent: number } => entry.percent != null)
      .sort((a, b) => (a.judgeUserId < b.judgeUserId ? -1 : 1));
    for (const flag of findOutliers(percents)) {
      outliers.push({
        submissionId: project.id,
        title: project.title,
        judgeUserId: flag.judgeUserId,
        judgeName: judgeById.get(flag.judgeUserId)?.name ?? "Judge",
        score: flag.score,
        othersMean: flag.othersMean,
        difference: flag.difference,
        judges: percents.length,
        rule: flag.rule,
      });
    }
  }
  belowTarget.sort((a, b) => a.reviews - b.reviews || a.assigned - b.assigned || a.title.localeCompare(b.title) || (a.submissionId < b.submissionId ? -1 : 1));
  outliers.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.title.localeCompare(b.title) || (a.judgeUserId < b.judgeUserId ? -1 : 1));

  // Per judge: invited judges always; organisers once they have assignments, scores or reviews.
  const assignedByJudge = new Map<string, Set<string>>();
  for (const row of validAssignments) assignedByJudge.set(row.judgeUserId, (assignedByJudge.get(row.judgeUserId) ?? new Set()).add(row.submissionId));
  const startedByJudge = new Map<string, number>();
  for (const entry of startedPairs.values()) startedByJudge.set(entry.judgeUserId, (startedByJudge.get(entry.judgeUserId) ?? 0) + 1);
  const submittedByJudge = new Map<string, Set<string>>();
  for (const key of submittedPairs) {
    const [judgeUserId, submissionId] = key.split("\u0000") as [string, string];
    submittedByJudge.set(judgeUserId, (submittedByJudge.get(judgeUserId) ?? new Set()).add(submissionId));
  }
  // Projects each judge may not see (conflicts of interest), from the conflicted pairs.
  const conflictedByJudge = new Map<string, number>();
  for (const key of conflicted) {
    const judgeUserId = key.split("\u0000")[0]!;
    conflictedByJudge.set(judgeUserId, (conflictedByJudge.get(judgeUserId) ?? 0) + 1);
  }
  const judgeRows: ProgressJudgeRow[] = [];
  for (const judge of eligible) {
    const assignedSet = assignedByJudge.get(judge.userId) ?? new Set<string>();
    const submittedSet = submittedByJudge.get(judge.userId) ?? new Set<string>();
    const started = startedByJudge.get(judge.userId) ?? 0;
    if (judge.kind === "admin" && assignedSet.size === 0 && submittedSet.size === 0 && started === 0) continue;
    const expected = round.judgesSeeAll ? projects.length - (conflictedByJudge.get(judge.userId) ?? 0) : assignedSet.size;
    const done = round.judgesSeeAll ? submittedSet.size : [...submittedSet].filter((id) => assignedSet.has(id)).length;
    judgeRows.push({
      userId: judge.userId,
      name: judge.name,
      email: judge.email,
      kind: judge.kind,
      assigned: expected,
      started,
      submitted: submittedSet.size,
      completion: completionPercent(done, expected),
    });
  }
  judgeRows.sort((a, b) => a.completion - b.completion || a.name.localeCompare(b.name) || (a.userId < b.userId ? -1 : 1));

  const stale: ProgressStaleRow[] = [...startedPairs.values()]
    .filter((entry) => isStaleReview(entry.lastSavedAt, now))
    .sort((a, b) => a.lastSavedAt.getTime() - b.lastSavedAt.getTime() || (a.submissionId < b.submissionId ? -1 : 1) || (a.judgeUserId < b.judgeUserId ? -1 : 1))
    .map((entry) => ({
      submissionId: entry.submissionId,
      title: projectById.get(entry.submissionId)?.title ?? "Project",
      judgeUserId: entry.judgeUserId,
      judgeName: judgeById.get(entry.judgeUserId)?.name ?? "Judge",
      scored: entry.scored,
      criteria: criteria.length,
      lastSavedAt: entry.lastSavedAt.toISOString(),
    }));

  return {
    summary: {
      target,
      targetIsDefault: round.reviewsPerProject == null,
      reviewsPerProject: round.reviewsPerProject,
      judgingStatus: judgingStatusFor(round.status),
      judgesSeeAll: round.judgesSeeAll,
      projects: projects.length,
      projectsAtTarget: projects.length - belowTarget.length,
      reviewsCounted: submittedPairs.size,
      coverage: completionPercent(towardsTarget, projects.length * target),
    },
    belowTarget,
    judges: judgeRows,
    outliers,
    stale,
  };
}

/** The Progress tab: the summary and the first page of every list, for one round. Null when the event (or that round) is gone. */
export async function loadJudgingProgress(ctx: JudgingOrganiserContext, now: Date = new Date(), options: { roundId?: string | null } = {}): Promise<JudgingProgressDto | null> {
  const model = await buildProgressModel(ctx, now, options.roundId);
  if (!model) return null;
  return {
    summary: model.summary,
    belowTarget: numberedPage(model.belowTarget, 1, JUDGING_PROGRESS_PAGE_SIZE),
    judges: numberedPage(model.judges, 1, JUDGING_PROGRESS_PAGE_SIZE),
    outliers: numberedPage(model.outliers, 1, JUDGING_PROGRESS_PAGE_SIZE),
    stale: numberedPage(model.stale, 1, JUDGING_PROGRESS_PAGE_SIZE),
  };
}

/** One numbered page of one Progress list (a page past the end shows the last page). */
export async function loadJudgingProgressPage(ctx: JudgingOrganiserContext, input: unknown, now: Date = new Date(), options: { roundId?: string | null } = {}): Promise<JudgingProgressSectionDto | null> {
  const parsed = judgingProgressQuerySchema.safeParse(input);
  if (!parsed.success) return null;
  const model = await buildProgressModel(ctx, now, options.roundId);
  if (!model) return null;
  const { section, page } = parsed.data as { section: JudgingProgressSection; page: number };
  switch (section) {
    case "below-target":
      return { section, page: numberedPage(model.belowTarget, page, JUDGING_PROGRESS_PAGE_SIZE) };
    case "judges":
      return { section, page: numberedPage(model.judges, page, JUDGING_PROGRESS_PAGE_SIZE) };
    case "outliers":
      return { section, page: numberedPage(model.outliers, page, JUDGING_PROGRESS_PAGE_SIZE) };
    case "stale":
      return { section, page: numberedPage(model.stale, page, JUDGING_PROGRESS_PAGE_SIZE) };
  }
}
