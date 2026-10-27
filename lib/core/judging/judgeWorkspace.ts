import "server-only";

/** The judge's workspace: paged list with totals, one submission for scoring, and "Score next project". */

import { JudgingStatus, Prisma, SubmissionStatus } from "@prisma/client";
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
import { judgeSubmissionDto, type JudgeSubmissionDetailDto, type JudgeSubmissionsPageDto, type JudgeWorkspaceDto } from "@/lib/judgingDto";
import { criteriaFor, isId, judgingEventSelect, projectSelect } from "./shared";
import { conflictKeysFor, isEligibleJudge } from "./judges";
import { judgeFilterSql, judgeVisibleSql, reviewedBySql, scoredBySql, visibleSubmissionIds } from "./judgeVisibility";

// ---------------------------------------------------------------------------
// Judge workspace
// ---------------------------------------------------------------------------

const EMPTY_JUDGE_COUNTS: JudgeSubmissionCounts = { all: 0, todo: 0, in_progress: 0, reviewed: 0 };

/** The event and the judge's conflict keys, once eligibility is confirmed; null otherwise. */
async function judgeListScope(ctx: JudgeContext) {
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: judgingEventSelect });
  if (!event?.submissionsEnabled) return null;
  if (!(await isEligibleJudge(prisma, event.organisationId, event.id, ctx.userId))) return null;
  const conflicts = (await conflictKeysFor(prisma, event.id, [ctx.userId])).get(ctx.userId);
  return { event, visible: judgeVisibleSql(event, ctx.userId, conflicts) };
}

/** Totals over every submission this judge may see (ignores the search and the page). */
async function judgeSubmissionCounts(visible: Prisma.Sql[], judgeUserId: string): Promise<JudgeSubmissionCounts> {
  const reviewed = reviewedBySql(judgeUserId);
  const [row] = await prisma.$queryRaw<Array<{ all: bigint; reviewed: bigint; in_progress: bigint }>>`
    SELECT count(*) AS "all",
           count(*) FILTER (WHERE ${reviewed}) AS "reviewed",
           count(*) FILTER (WHERE NOT ${reviewed} AND ${scoredBySql(judgeUserId)}) AS "in_progress"
    FROM "Submission" s
    WHERE ${Prisma.join(visible, " AND ")}`;
  if (!row) return { ...EMPTY_JUDGE_COUNTS };
  const all = Number(row.all);
  const done = Number(row.reviewed);
  return { all, reviewed: done, in_progress: Number(row.in_progress), todo: all - done };
}

/** One bounded page of the judge's list (keyset on `submittedAt, id`), with progress for those rows only. */
async function judgeSubmissionsPage(
  scope: { event: { id: string }; visible: Prisma.Sql[] },
  judgeUserId: string,
  query: { query: string; filter: JudgeSubmissionFilter; cursor?: string | null },
): Promise<Omit<JudgeSubmissionsPageDto, "counts">> {
  const empty = { submissions: [], nextCursor: null };
  const conditions = [...scope.visible];
  const filter = judgeFilterSql(query.filter, judgeUserId);
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
      where: { id: { in: pageIds }, eventId: scope.event.id, status: SubmissionStatus.SUBMITTED },
      select: { ...projectSelect, submittedAt: true },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
    }),
    prisma.judgeScore.groupBy({ by: ["submissionId"], where: { judgeUserId, submissionId: { in: pageIds } }, _count: { _all: true } }),
    prisma.judgeReview.findMany({ where: { judgeUserId, submissionId: { in: pageIds }, submittedAt: { not: null } }, select: { submissionId: true } }),
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
export async function listSubmissionsForJudge(ctx: JudgeContext, input: unknown = {}): Promise<JudgeWorkspaceDto | null> {
  const scope = await judgeListScope(ctx);
  if (!scope) return null;
  const parsed = judgeSubmissionsQuerySchema.safeParse(input);
  const [criteria, counts, page] = await Promise.all([
    criteriaFor(prisma, scope.event.id),
    judgeSubmissionCounts(scope.visible, ctx.userId),
    parsed.success ? judgeSubmissionsPage(scope, ctx.userId, parsed.data) : Promise.resolve({ submissions: [], nextCursor: null }),
  ]);
  return { judgingStatus: scope.event.judgingStatus, criteria, counts, ...page };
}

/** One page of the judge's list for a filter, a search, or "Load more", with fresh totals. */
export async function listJudgeSubmissionsPage(ctx: JudgeContext, input: unknown): Promise<JudgeSubmissionsPageDto | null> {
  const scope = await judgeListScope(ctx);
  if (!scope) return null;
  const parsed = judgeSubmissionsQuerySchema.safeParse(input);
  const [counts, page] = await Promise.all([
    judgeSubmissionCounts(scope.visible, ctx.userId),
    parsed.success ? judgeSubmissionsPage(scope, ctx.userId, parsed.data) : Promise.resolve({ submissions: [], nextCursor: null }),
  ]);
  return { counts, ...page };
}

/** One submission for scoring, with this judge's own scores and review. */
export async function loadSubmissionForJudge(ctx: JudgeContext, submissionId: string): Promise<JudgeSubmissionDetailDto | null> {
  if (!isId(submissionId)) return null;
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: judgingEventSelect });
  if (!event?.submissionsEnabled) return null;
  if (!(await isEligibleJudge(prisma, event.organisationId, event.id, ctx.userId))) return null;
  const ids = await visibleSubmissionIds(prisma, event, ctx.userId, submissionId);
  if (!ids.includes(submissionId)) return null;
  const [criteria, row, scores, review] = await Promise.all([
    criteriaFor(prisma, event.id),
    prisma.submission.findFirst({ where: { id: submissionId, eventId: event.id }, select: projectSelect }),
    prisma.judgeScore.findMany({ where: { submissionId, judgeUserId: ctx.userId }, select: { criterionId: true, score: true } }),
    prisma.judgeReview.findUnique({ where: { submissionId_judgeUserId: { submissionId, judgeUserId: ctx.userId } }, select: { comment: true, submittedAt: true } }),
  ]);
  if (!row) return null;
  return {
    judgingStatus: event.judgingStatus,
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
export async function nextSubmissionForJudge(ctx: JudgeContext): Promise<JudgeNextDto | null> {
  const scope = await judgeListScope(ctx);
  if (!scope) return null;
  if (scope.event.judgingStatus !== JudgingStatus.OPEN) return { next: null, remaining: 0 };
  const notReviewed = Prisma.sql`NOT ${reviewedBySql(ctx.userId)}`;
  const conditions = [...scope.visible, notReviewed];
  const started = Prisma.sql`(${scoredBySql(ctx.userId)} OR EXISTS (SELECT 1 FROM "JudgeReview" jd WHERE jd."submissionId" = s."id" AND jd."judgeUserId" = ${ctx.userId}))`;
  const [picked, [remainingRow]] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT s."id" FROM "Submission" s
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY (CASE WHEN ${started} THEN 0 ELSE 1 END) ASC,
               (SELECT count(*) FROM "JudgeReview" rc WHERE rc."submissionId" = s."id" AND rc."submittedAt" IS NOT NULL) ASC,
               s."submittedAt" ASC NULLS LAST,
               s."id" ASC
      LIMIT 1`,
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS "count" FROM "Submission" s WHERE ${Prisma.join(conditions, " AND ")}`,
  ]);
  const remaining = Number(remainingRow?.count ?? 0);
  const id = picked[0]?.id;
  if (!id) return { next: null, remaining: 0 };
  const next = await loadSubmissionForJudge(ctx, id);
  return { next, remaining: next ? remaining : 0 };
}
