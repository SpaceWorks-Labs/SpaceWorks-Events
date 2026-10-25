import "server-only";

/** Judging CSV exports (results and submissions), streamed in bounded batches. */

import { ScoreNormalization, SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  matchesProjectQuery,
  matchesScoreFilter,
  type OrganiserSubmissionFilter,
  type ResultsScoreFilter,
  type SubmissionViewFilter,
} from "@/lib/judgingOrganiserPaging";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { listUnsubmittedEntrants } from "@/lib/core/judgingEntrants";
import { safeTimeZone, zonedIsoWithOffset } from "@/lib/timeZone";
import { JUDGING_EXPORT_BATCH_SIZE } from "./shared";
import { listSubmissionsForOrganiser } from "./organiserSubmissions";
import { loadJudgingResults } from "./results";

/** A CSV export ready to stream: the header row, then bounded batches of rows. */
export type CsvExportPlan = {
  header: string[];
  batches: () => AsyncGenerator<string[][]>;
};

export type JudgingResultsExportView = {
  /** The Results search (title or entrant); ranks are computed over every project first. */
  query?: string;
  /** The Results score chip. */
  scored?: ResultsScoreFilter;
  /** The score method the table shows; the event's saved one when omitted. */
  method?: ScoreNormalization;
};

/**
 * `/api/exports/events/{eventId}/judging` (owners and admins only): one row
 * per review, with the result score (the active method's, which ranks) and
 * both the raw and the adjusted score. Judge names, no emails, no comments.
 * The ranking is computed over every project, like Judging → Results, and a
 * search keeps the matching ranked rows without renumbering them. Reviews
 * and scores are read for JUDGING_EXPORT_BATCH_SIZE projects at a time.
 * `rows` counts the projects in the file. Cells go through `buildCsv`.
 */
export async function planJudgingResultsExport(
  ctx: JudgingOrganiserContext,
  view: JudgingResultsExportView = {},
): Promise<(CsvExportPlan & { rows: number; method: ScoreNormalization }) | null> {
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: { id: true, timezone: true } });
  if (!event) return null;
  const results = await loadJudgingResults(ctx, { method: view.method });
  if (!results) return null;
  const query = view.query?.trim() ?? "";
  const scored = view.scored ?? "all";
  // The same filters as loadJudgingResultsPage, over the whole ranking.
  const matching = results.rows.filter((row) => matchesScoreFilter(row, scored) && (!query || matchesProjectQuery(row, query)));
  // Same clock as the dashboard: ISO 8601 in the event timezone, with its offset.
  const timeZone = safeTimeZone(event.timezone);
  const counted = new Set(results.countedReviewKeys);
  const header = ["Rank", "Project", "Entrant", "Status", "Result score", "Raw score", "Adjusted score", "Judges counted", "Judge", `Review submitted (${timeZone})`, "Counted in score", ...results.criteria.map((criterion) => `${criterion.name} (/${criterion.maxScore}, weight ${criterion.weight})`)];

  async function* batches(): AsyncGenerator<string[][]> {
    for (let start = 0; start < matching.length; start += JUDGING_EXPORT_BATCH_SIZE) {
      const chunk = matching.slice(start, start + JUDGING_EXPORT_BATCH_SIZE);
      const ids = chunk.map((row) => row.submissionId);
      const scoped = { id: { in: ids }, eventId: event!.id, event: { organisationId: ctx.organisationId } };
      const [scores, reviews] = await Promise.all([
        prisma.judgeScore.findMany({ where: { submission: scoped }, select: { submissionId: true, judgeUserId: true, criterionId: true, score: true } }),
        prisma.judgeReview.findMany({
          where: { submission: scoped },
          select: { submissionId: true, judgeUserId: true, submittedAt: true, judge: { select: { name: true } } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
      ]);
      const scoreIndex = new Map(scores.map((score) => [`${score.submissionId}\u0000${score.judgeUserId}\u0000${score.criterionId}`, score.score]));
      const rows: string[][] = [];
      for (const row of chunk) {
        const rowReviews = reviews.filter((review) => review.submissionId === row.submissionId);
        const base = [
          row.rank?.toString() ?? "",
          row.title,
          row.entrantName,
          row.status,
          row.score?.toFixed(1) ?? "",
          row.rawScore?.toFixed(1) ?? "",
          row.adjustedScore?.toFixed(1) ?? "",
          String(row.judgesCounted),
        ];
        if (rowReviews.length === 0) {
          rows.push([...base, "", "", "", ...results!.criteria.map(() => "")]);
          continue;
        }
        for (const review of rowReviews) {
          const key = `${row.submissionId}\u0000${review.judgeUserId}`;
          rows.push([
            ...base,
            review.judge.name?.trim() || "Judge",
            review.submittedAt ? zonedIsoWithOffset(review.submittedAt, timeZone) : "",
            counted.has(key) ? "Yes" : "No",
            ...results!.criteria.map((criterion) => scoreIndex.get(`${key}\u0000${criterion.id}`)?.toString() ?? ""),
          ]);
        }
      }
      yield rows;
    }
  }

  return { header, batches, rows: matching.length, method: results.scoreNormalization };
}

/** Every row of the judging scores CSV, header first (tests and small callers; the route streams the plan). */
export async function buildJudgingExportRows(ctx: JudgingOrganiserContext, view: JudgingResultsExportView = {}): Promise<string[][] | null> {
  const plan = await planJudgingResultsExport(ctx, view);
  if (!plan) return null;
  const rows: string[][] = [plan.header];
  for await (const batch of plan.batches()) rows.push(...batch);
  return rows;
}

export type JudgingSubmissionsExportView = { query?: string; status?: SubmissionViewFilter };

/**
 * Judging → Submissions → "Export CSV" (owners and admins only): every
 * project matching the view's status filter and search, through the view's
 * own query (`listSubmissionsForOrganiser`) in keyset batches. One row per
 * project with its links, the organiser-only disqualification reason and
 * the assigned judges' names; no entrant emails, answers, tickets, scores or
 * comments. Times in the event timezone with the offset.
 */
export async function planJudgingSubmissionsExport(ctx: JudgingOrganiserContext, view: JudgingSubmissionsExportView = {}): Promise<CsvExportPlan | null> {
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: { id: true, timezone: true } });
  if (!event) return null;
  const timeZone = safeTimeZone(event.timezone);
  if (view.status === "notSubmitted") return planUnsubmittedEntrantsExport(ctx, view.query?.trim() ?? "", timeZone);
  const header = ["Project", "Entrant", "Entry", "Status", `Submitted (${timeZone})`, `Last updated (${timeZone})`, "Summary", "Code", "Demo", "Video", "Assigned judges", "Disqualification reason"];
  const filter = { query: view.query?.trim() ?? "", status: (view.status ?? "all") as OrganiserSubmissionFilter };

  async function* batches(): AsyncGenerator<string[][]> {
    let cursor: string | null = null;
    do {
      const page = await listSubmissionsForOrganiser(ctx, { ...filter, cursor }, { pageSize: JUDGING_EXPORT_BATCH_SIZE });
      if (page.submissions.length === 0) break;
      const judgeIds = [...new Set(page.submissions.flatMap((submission) => submission.assignedJudgeIds))];
      const judges = judgeIds.length ? await prisma.user.findMany({ where: { id: { in: judgeIds } }, select: { id: true, name: true } }) : [];
      const judgeNames = new Map(judges.map((judge) => [judge.id, judge.name?.trim() || "Judge"]));
      yield page.submissions.map((submission) => [
        submission.title,
        submission.entrantName,
        submission.isTeam ? "Team" : "Solo",
        submission.status,
        submission.submittedAt ? zonedIsoWithOffset(submission.submittedAt, timeZone) : "",
        zonedIsoWithOffset(submission.updatedAt, timeZone),
        submission.summary,
        submission.repoUrl ?? "",
        submission.demoUrl ?? "",
        submission.videoUrl ?? "",
        submission.assignedJudgeIds.map((id) => judgeNames.get(id) ?? "Judge").join("; "),
        submission.status === SubmissionStatus.DISQUALIFIED ? submission.disqualifiedReason ?? "" : "",
      ]);
      cursor = page.nextCursor;
    } while (cursor);
  }

  return { header, batches };
}

/**
 * Submissions → "Not submitted" as CSV: entrants (confirmed teams and solo
 * registrants) without a SUBMITTED project, through the view's own query
 * (`listUnsubmittedEntrants`) one keyset page at a time. Names and sizes,
 * never emails.
 */
function planUnsubmittedEntrantsExport(ctx: JudgingOrganiserContext, query: string, timeZone: string): CsvExportPlan {
  const header = ["Entrant", "Entry", "Size", "Project status", "Project", `Registered (${timeZone})`];
  async function* batches(): AsyncGenerator<string[][]> {
    let cursor: string | null = null;
    do {
      const page = await listUnsubmittedEntrants(ctx, { query, cursor });
      if (page.entrants.length === 0) break;
      yield page.entrants.map((entrant) => [
        entrant.name,
        entrant.kind === "team" ? "Team" : "Solo",
        String(entrant.size),
        entrant.submissionStatus ?? "None",
        entrant.submissionTitle ?? "",
        zonedIsoWithOffset(entrant.registeredAt, timeZone),
      ]);
      cursor = page.nextCursor;
    } while (cursor);
  }
  return { header, batches };
}
