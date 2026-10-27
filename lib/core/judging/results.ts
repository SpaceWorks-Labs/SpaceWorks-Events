import "server-only";

/** Organiser results: the ranked score table, its numbered pages, and the Awards winner picker. */

import { JudgingStatus, ScoreNormalization, SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { computeJudgingResultsFromReviews, type CriterionAverage } from "@/lib/judgingScore";
import { submittedReviewScores } from "./judgeWork";
import {
  AWARD_CANDIDATES_PAGE_SIZE,
  awardCandidatesQuerySchema,
  countScoreFilters,
  JUDGING_RESULTS_PAGE_SIZE,
  judgingResultsQuerySchema,
  matchesProjectQuery,
  matchesScoreFilter,
  numberedPage,
  offsetPage,
  type NumberedPage,
  type OffsetPage,
  type ResultsScoreFilter,
} from "@/lib/judgingOrganiserPaging";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { entrantDisplayName, type JudgingCriterionDto } from "@/lib/judgingDto";
import { criteriaFor, judgingEventSelect, nameSourceSelect } from "./shared";
import { conflictKeysFor, hasConflictOfInterest, listEligibleJudges } from "./judges";

export type ResultRowDto = {
  submissionId: string;
  title: string;
  entrantName: string;
  status: SubmissionStatus;
  /** The active method's score, which ranks (rawScore or adjustedScore). */
  score: number | null;
  rawScore: number | null;
  adjustedScore: number | null;
  judgesCounted: number;
  rank: number | null;
  criterionAverages: CriterionAverage[];
};

export type JudgeProgressDto = {
  userId: string;
  name: string;
  /** Submissions this judge can see (assignment rule and conflicts applied). */
  visible: number;
  reviewsSubmitted: number;
};

export type JudgingResultsDto = {
  judgingStatus: JudgingStatus;
  resultsPublishedAt: Date | null;
  /** Which score ranks: RAW, or ZSCORE ("Adjust for harsh/generous judges"). */
  scoreNormalization: ScoreNormalization;
  criteria: JudgingCriterionDto[];
  /** SUBMITTED projects ranked; DISQUALIFIED ones follow with no rank. */
  rows: ResultRowDto[];
  /** `submissionId\0judgeUserId` of every review counted in the scores (server-side only, for the CSV export). */
  countedReviewKeys: string[];
};

/**
 * The organiser's ranked score table, computed over every SUBMITTED and
 * DISQUALIFIED project (ranks need the whole set). The dashboard shows it a
 * page at a time (`loadJudgingResultsPage`); the CSV export uses all of it.
 * Per-judge progress comes from `loadJudgeProgress`, with aggregates.
 */
export async function loadJudgingResults(ctx: JudgingOrganiserContext, options: { method?: ScoreNormalization } = {}): Promise<JudgingResultsDto | null> {
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: { ...judgingEventSelect, scoreNormalization: true } });
  if (!event) return null;
  const [criteria, submissions, reviews, eligible] = await Promise.all([
    criteriaFor(prisma, event.id),
    prisma.submission.findMany({
      where: { eventId: event.id, status: { in: [SubmissionStatus.SUBMITTED, SubmissionStatus.DISQUALIFIED] } },
      select: { id: true, title: true, status: true, teamId: true, rsvpId: true, ...nameSourceSelect },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
    }),
    // Submitted reviews of SUBMITTED projects with their scores, one row per review.
    submittedReviewScores(prisma, event.id),
    listEligibleJudges(ctx),
  ]);
  const submitted = submissions.filter((row) => row.status === SubmissionStatus.SUBMITTED);
  const byId = new Map(submissions.map((row) => [row.id, row]));
  const eligibleIds = new Set(eligible.map((judge) => judge.userId));
  const reviewAuthorIds = [...new Set(reviews.map((review) => review.judgeUserId))];
  const authorConflicts = await conflictKeysFor(prisma, event.id, reviewAuthorIds);
  // Only reviews that may count: submitted, of a SUBMITTED project (both
  // checked in SQL above), by someone who can still judge this event, with no
  // conflict of interest now. A revoked JUDGE grant or a judge who later
  // registered on that entrant drops out of the score (their rows stay, for
  // the organiser's record).
  const submittedReviews = reviews.filter((review) => {
    const row = byId.get(review.submissionId);
    return Boolean(row?.status === SubmissionStatus.SUBMITTED && eligibleIds.has(review.judgeUserId) && !hasConflictOfInterest(row, authorConflicts.get(review.judgeUserId)));
  });
  // The saved method ranks, unless the caller names one (the Results CSV
  // passes the method the organiser's table is showing).
  const method = options.method ?? event.scoreNormalization;
  const results = computeJudgingResultsFromReviews({ submissionIds: submitted.map((row) => row.id), criteria, reviews: submittedReviews, method });
  const rows: ResultRowDto[] = [
    ...results.map((result) => {
      const row = byId.get(result.submissionId)!;
      return { ...result, title: row.title, entrantName: entrantDisplayName(row), status: row.status };
    }),
    ...submissions
      .filter((row) => row.status === SubmissionStatus.DISQUALIFIED)
      .map((row) => ({
        submissionId: row.id,
        title: row.title,
        entrantName: entrantDisplayName(row),
        status: row.status,
        score: null,
        rawScore: null,
        adjustedScore: null,
        judgesCounted: 0,
        rank: null,
        criterionAverages: criteria.map((criterion) => ({ criterionId: criterion.id, average: null })),
      })),
  ];

  const countedReviewKeys = submittedReviews.map((review) => `${review.submissionId}\u0000${review.judgeUserId}`);
  return { judgingStatus: event.judgingStatus, resultsPublishedAt: event.resultsPublishedAt, scoreNormalization: method, criteria, rows, countedReviewKeys };
}

export type JudgingResultsPageDto = NumberedPage<ResultRowDto> & {
  criteria: JudgingCriterionDto[];
  scoreNormalization: ScoreNormalization;
  /** The search the page was filtered by ("" for none). */
  query: string;
  /** Every row in the ranking, before any search. */
  rankedTotal: number;
  /** The score filter the page was filtered by ("all" for none). */
  scored: ResultsScoreFilter;
  /** Rows per score filter over the whole ranking (before the search), for the chips. */
  scoreCounts: Record<ResultsScoreFilter, number>;
};

/**
 * One numbered page of the ranked table. The ranking is computed over every
 * project first, so a rank (and a tie) is the same on every page and in
 * every search; a search only filters which ranked rows are shown.
 */
export async function loadJudgingResultsPage(ctx: JudgingOrganiserContext, input: unknown = {}): Promise<JudgingResultsPageDto | null> {
  const parsed = judgingResultsQuerySchema.safeParse(input);
  if (!parsed.success) return null;
  const results = await loadJudgingResults(ctx);
  if (!results) return null;
  const { query, page, scored } = parsed.data;
  const matching = results.rows.filter((row) => matchesScoreFilter(row, scored) && (!query || matchesProjectQuery(row, query)));
  return {
    ...numberedPage(matching, page, JUDGING_RESULTS_PAGE_SIZE),
    criteria: results.criteria,
    scoreNormalization: results.scoreNormalization,
    query,
    rankedTotal: results.rows.length,
    scored,
    scoreCounts: countScoreFilters(results.rows),
  };
}

export type AwardCandidateDto = { submissionId: string; title: string; entrantName: string; rank: number | null; score: number | null };

/**
 * Projects for the Awards winner picker: SUBMITTED only (setAwardWinner
 * refuses anything else), in ranking order, searchable by title or entrant,
 * in short "Show more" steps.
 */
export async function searchAwardCandidates(ctx: JudgingOrganiserContext, input: unknown = {}): Promise<OffsetPage<AwardCandidateDto> | null> {
  const parsed = awardCandidatesQuerySchema.safeParse(input);
  if (!parsed.success) return null;
  const results = await loadJudgingResults(ctx);
  if (!results) return null;
  const { query, offset } = parsed.data;
  const candidates = results.rows
    .filter((row) => row.status === SubmissionStatus.SUBMITTED && matchesProjectQuery(row, query))
    .map((row) => ({ submissionId: row.submissionId, title: row.title, entrantName: row.entrantName, rank: row.rank, score: row.score }));
  return offsetPage(candidates, offset, AWARD_CANDIDATES_PAGE_SIZE);
}
