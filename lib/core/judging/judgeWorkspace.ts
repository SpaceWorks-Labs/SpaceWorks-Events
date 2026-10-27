import "server-only";

/** The judge's workspace: paged list with totals, one submission for scoring, and "Score next project". */

import { JudgingRoundStatus, JudgingStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sqlUtcTimestamp } from "@/lib/sqlTimestamp";
import {
  decodeSubmissionCursor,
  encodeSubmissionCursor,
  JUDGE_SUBMISSIONS_PAGE_SIZE,
  judgeSubmissionsQuerySchema,
  type JudgeSubmissionCounts,
  type JudgeSubmissionFilter,
} from "@/lib/judgingPaging";
import type { JudgeContext } from "@/lib/judgingAccess";
import { projectSearchSql } from "@/lib/galleryQuery";
import { judgeSubmissionDto, type JudgeRoundDto, type JudgeSubmissionDetailDto, type JudgeSubmissionsPageDto, type JudgeWorkspaceDto } from "@/lib/judgingDto";
import { criteriaFor, isId, judgingEventSelect, projectSelect } from "./shared";
import { conflictKeysFor, isEligibleJudge } from "./judges";
import { judgeFilterSql, judgeVisibleSql, reviewedBySql, scoredBySql, visibleSubmissionIds } from "./judgeVisibility";
import { judgingStatusFor, type JudgingRoundScope, onRoundPanel, resolveJudgingRound, roundProjectsWhere, roundScoresWhere } from "./rounds/scope";

/** Which round the workspace shows: `roundId`, else the current round (the one judges score). */
export type JudgeRoundOption = { roundId?: string | null };

// ---------------------------------------------------------------------------
// Judge workspace
// ---------------------------------------------------------------------------

const EMPTY_JUDGE_COUNTS: JudgeSubmissionCounts = { all: 0, todo: 0, in_progress: 0, reviewed: 0 };

/** The event's round and the judge's conflict keys, once eligibility is confirmed; null otherwise (or for another event's round). */
async function judgeListScope(ctx: JudgeContext, options: JudgeRoundOption = {}) {
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: judgingEventSelect });
  if (!event?.submissionsEnabled) return null;
  if (!(await isEligibleJudge(prisma, event.organisationId, event.id, ctx.userId))) return null;
  const round = await resolveJudgingRound(prisma, event, options.roundId);
  if (!round) return null;
  const conflicts = (await conflictKeysFor(prisma, event.id, [ctx.userId])).get(ctx.userId);
  return { event, round, visible: judgeVisibleSql(round, ctx.userId, conflicts) };
}

/** Every round of the event, as the workspace's switcher names them. */
async function roundBriefs(eventId: string): Promise<JudgeRoundDto[]> {
  const rows = await prisma.judgingRound.findMany({ where: { eventId }, orderBy: { position: "asc" }, select: { id: true, name: true, position: true, status: true } });
  const current = [...rows].reverse().find((row) => row.status !== JudgingRoundStatus.DRAFT) ?? rows[0];
  return rows.map((row) => ({ id: row.id, name: row.name, position: row.position, judgingStatus: judgingStatusFor(row.status), isCurrent: row.id === current?.id }));
}

function roundBrief(round: JudgingRoundScope): JudgeRoundDto | null {
  return round.id ? { id: round.id, name: round.name, position: round.position, judgingStatus: judgingStatusFor(round.status), isCurrent: round.isCurrent } : null;
}

/** Totals over every submission this judge may see (ignores the search and the page). */
async function judgeSubmissionCounts(round: JudgingRoundScope, visible: Prisma.Sql[], judgeUserId: string): Promise<JudgeSubmissionCounts> {
  const reviewed = reviewedBySql(round, judgeUserId);
  const [row] = await prisma.$queryRaw<Array<{ all: bigint; reviewed: bigint; in_progress: bigint }>>`
    SELECT count(*) AS "all",
           count(*) FILTER (WHERE ${reviewed}) AS "reviewed",
           count(*) FILTER (WHERE NOT ${reviewed} AND ${scoredBySql(round, judgeUserId)}) AS "in_progress"
    FROM "Submission" s
    WHERE ${Prisma.join(visible, " AND ")}`;
  if (!row) return { ...EMPTY_JUDGE_COUNTS };
  const all = Number(row.all);
  const done = Number(row.reviewed);
  return { all, reviewed: done, in_progress: Number(row.in_progress), todo: all - done };
}

/** One bounded page of the judge's list (keyset on `submittedAt, id`), with progress for those rows only. */
async function judgeSubmissionsPage(
  scope: { round: JudgingRoundScope; visible: Prisma.Sql[] },
  judgeUserId: string,
  query: { query: string; filter: JudgeSubmissionFilter; cursor?: string | null },
): Promise<Omit<JudgeSubmissionsPageDto, "counts">> {
  const empty = { submissions: [], nextCursor: null };
  const conditions = [...scope.visible];
  const filter = judgeFilterSql(query.filter, scope.round, judgeUserId);
  if (filter) conditions.push(filter);
  const search = projectSearchSql(query.query);
  if (search) conditions.push(search);
  if (query.cursor) {
    const after = decodeSubmissionCursor(query.cursor);
    if (!after) return empty;
    conditions.push(Prisma.sql`(s."submittedAt", s."id") > (${sqlUtcTimestamp(after.submittedAt)}, ${after.id})`);
  }
  const ids = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s."id" FROM "Submission" s
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY s."submittedAt" ASC, s."id" ASC
    LIMIT ${JUDGE_SUBMISSIONS_PAGE_SIZE + 1}`;
  const pageIds = ids.slice(0, JUDGE_SUBMISSIONS_PAGE_SIZE).map((row) => row.id);
  if (pageIds.length === 0) return empty;
  const [rows, scoreCounts, reviews] = await Promise.all([
    prisma.submission.findMany({
      where: { ...roundProjectsWhere(scope.round), id: { in: pageIds } },
      select: { ...projectSelect, submittedAt: true },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
    }),
    prisma.judgeScore.groupBy({ by: ["submissionId"], where: { judgeUserId, submissionId: { in: pageIds }, ...roundScoresWhere(scope.round) }, _count: { _all: true } }),
    prisma.judgeReview.findMany({ where: { judgeUserId, roundId: scope.round.id, submissionId: { in: pageIds }, submittedAt: { not: null } }, select: { submissionId: true } }),
  ]);
  const scored = new Map(scoreCounts.map((row) => [row.submissionId, row._count._all]));
  const submitted = new Set(reviews.map((row) => row.submissionId));
  const last = rows[rows.length - 1];
  return {
    submissions: rows.map((row) => judgeSubmissionDto(row, { scoredCriteria: scored.get(row.id) ?? 0, reviewSubmitted: submitted.has(row.id) })),
    nextCursor: ids.length > JUDGE_SUBMISSIONS_PAGE_SIZE && last?.submittedAt ? encodeSubmissionCursor({ submittedAt: last.submittedAt, id: last.id }) : null,
  };
}

/**
 * The judge's workspace: the rubric, totals, and the first page of the list
 * (or the page `input` asks for). Project content and this judge's own
 * progress only. Null when the event is gone, not a judging event, or the
 * user is not a judge for it; an invalid `input` gives an empty page.
 */
export async function listSubmissionsForJudge(ctx: JudgeContext, input: unknown = {}, options: JudgeRoundOption = {}): Promise<JudgeWorkspaceDto | null> {
  const scope = await judgeListScope(ctx, options);
  if (!scope) return null;
  const parsed = judgeSubmissionsQuerySchema.safeParse(input);
  const [criteria, counts, page, rounds] = await Promise.all([
    criteriaFor(prisma, scope.round),
    judgeSubmissionCounts(scope.round, scope.visible, ctx.userId),
    parsed.success ? judgeSubmissionsPage(scope, ctx.userId, parsed.data) : Promise.resolve({ submissions: [], nextCursor: null }),
    roundBriefs(scope.event.id),
  ]);
  return {
    judgingStatus: judgingStatusFor(scope.round.status),
    criteria,
    counts,
    ...page,
    round: roundBrief(scope.round),
    rounds,
    onPanel: onRoundPanel(scope.round, ctx.userId),
  };
}

/** One page of the judge's list for a filter, a search, or "Load more", with fresh totals. */
export async function listJudgeSubmissionsPage(ctx: JudgeContext, input: unknown, options: JudgeRoundOption = {}): Promise<JudgeSubmissionsPageDto | null> {
  const scope = await judgeListScope(ctx, options);
  if (!scope) return null;
  const parsed = judgeSubmissionsQuerySchema.safeParse(input);
  const [counts, page] = await Promise.all([
    judgeSubmissionCounts(scope.round, scope.visible, ctx.userId),
    parsed.success ? judgeSubmissionsPage(scope, ctx.userId, parsed.data) : Promise.resolve({ submissions: [], nextCursor: null }),
  ]);
  return { counts, ...page };
}

/** One submission for scoring, with this judge's own scores and review. */
export async function loadSubmissionForJudge(ctx: JudgeContext, submissionId: string, options: JudgeRoundOption = {}): Promise<JudgeSubmissionDetailDto | null> {
  if (!isId(submissionId)) return null;
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: judgingEventSelect });
  if (!event?.submissionsEnabled) return null;
  if (!(await isEligibleJudge(prisma, event.organisationId, event.id, ctx.userId))) return null;
  const round = await resolveJudgingRound(prisma, event, options.roundId);
  if (!round) return null;
  const ids = await visibleSubmissionIds(prisma, round, ctx.userId, submissionId);
  if (!ids.includes(submissionId)) return null;
  const [criteria, row, scores, review] = await Promise.all([
    criteriaFor(prisma, round),
    prisma.submission.findFirst({ where: { id: submissionId, eventId: event.id }, select: projectSelect }),
    prisma.judgeScore.findMany({ where: { submissionId, judgeUserId: ctx.userId, ...roundScoresWhere(round) }, select: { criterionId: true, score: true } }),
    prisma.judgeReview.findFirst({ where: { roundId: round.id, submissionId, judgeUserId: ctx.userId }, select: { comment: true, submittedAt: true } }),
  ]);
  if (!row) return null;
  return {
    judgingStatus: judgingStatusFor(round.status),
    criteria,
    submission: judgeSubmissionDto(row, { scoredCriteria: scores.length, reviewSubmitted: Boolean(review?.submittedAt) }),
    myScores: scores.map((score) => ({ criterionId: score.criterionId, score: score.score })),
    myReview: review ? { comment: review.comment, submittedAt: review.submittedAt } : null,
  };
}

export type JudgeNextDto = {
  /** The project to score next, loaded as for scoring; null when nothing is left (or judging is not open). */
  next: JudgeSubmissionDetailDto | null;
  /** Projects this judge may still review, including `next`. */
  remaining: number;
};

/**
 * "Score next project": among the projects this judge may score now (judging
 * OPEN; SUBMITTED; assigned unless judgesSeeAll; no conflict of interest)
 * that they have not submitted a review for, the one they already started
 * (saved scores or a draft comment), then the one with the fewest submitted
 * reviews from anyone, then the oldest `submittedAt`, then id. So the
 * workload spreads evenly and a half-done review is finished first. Chosen on
 * the server in one query with the list's visibility rules; the pick is then
 * loaded through `loadSubmissionForJudge`, which re-checks access. Null when
 * the user is not a judge for this event.
 */
export async function nextSubmissionForJudge(ctx: JudgeContext, options: JudgeRoundOption = {}): Promise<JudgeNextDto | null> {
  const scope = await judgeListScope(ctx, options);
  if (!scope) return null;
  if (judgingStatusFor(scope.round.status) !== JudgingStatus.OPEN) return { next: null, remaining: 0 };
  const roundId = scope.round.id;
  const notReviewed = Prisma.sql`NOT ${reviewedBySql(scope.round, ctx.userId)}`;
  const conditions = [...scope.visible, notReviewed];
  const started = Prisma.sql`(${scoredBySql(scope.round, ctx.userId)} OR EXISTS (SELECT 1 FROM "JudgeReview" jd WHERE jd."submissionId" = s."id" AND jd."judgeUserId" = ${ctx.userId} AND jd."roundId" = ${roundId}))`;
  const [picked, [remainingRow]] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT s."id" FROM "Submission" s
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY (CASE WHEN ${started} THEN 0 ELSE 1 END) ASC,
               (SELECT count(*) FROM "JudgeReview" rc WHERE rc."submissionId" = s."id" AND rc."roundId" = ${roundId} AND rc."submittedAt" IS NOT NULL) ASC,
               s."submittedAt" ASC NULLS LAST,
               s."id" ASC
      LIMIT 1`,
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS "count" FROM "Submission" s WHERE ${Prisma.join(conditions, " AND ")}`,
  ]);
  const remaining = Number(remainingRow?.count ?? 0);
  const id = picked[0]?.id;
  if (!id) return { next: null, remaining: 0 };
  const next = await loadSubmissionForJudge(ctx, id, { roundId: scope.round.id });
  return { next, remaining: next ? remaining : 0 };
}
