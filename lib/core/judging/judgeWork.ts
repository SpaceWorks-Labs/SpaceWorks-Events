import "server-only";

/** Judges' work on SUBMITTED projects, aggregated in SQL for the large-event read paths (docs/HACKATHON.md). */

import { Prisma, SubmissionStatus } from "@prisma/client";
import type { CountedReview } from "@/lib/judgingScore";
import { pairKey } from "@/lib/judgingAssignment";
import type { ConflictKeys } from "./judges";

/** One judge's work on one SUBMITTED project: a review row, saved scores, or both. */
export type JudgePairWork = {
  submissionId: string;
  judgeUserId: string;
  /** A review row exists (draft or submitted). */
  reviewed: boolean;
  /** The review's submission time; null for a draft review or scores without a review. */
  submittedAt: Date | null;
  /** Saved score rows. */
  scored: number;
  /** The newest saved score; null without scores. */
  lastSavedAt: Date | null;
  /** The saved scores by criterion id (empty unless read `withScores`). */
  scores: Map<string, number>;
};

/**
 * Every (judge, SUBMITTED project) pair of the event with a review row or
 * saved scores, aggregated in SQL: one row per pair rather than one per
 * score. Scores are grouped per project through the
 * `JudgeScore (submissionId, judgeUserId, criterionId)` unique index, so the
 * read is proportional to this event's projects and never sorts or scans
 * every score of the instance. Sorted by project then judge. Eligibility
 * and conflicts of interest are the caller's to apply.
 */
export async function judgeWorkOnSubmitted(client: Prisma.TransactionClient, eventId: string, options: { withScores: boolean }): Promise<JudgePairWork[]> {
  const arrays = options.withScores
    ? Prisma.sql`array_agg(js."criterionId") AS "criterionIds", array_agg(js."score") AS "scores"`
    : Prisma.sql`'{}'::text[] AS "criterionIds", '{}'::int[] AS "scores"`;
  const submitted = Prisma.sql`s."eventId" = ${eventId} AND s."status" = ${SubmissionStatus.SUBMITTED}::"SubmissionStatus"`;
  const [scoreRows, reviewRows] = await Promise.all([
    client.$queryRaw<Array<{ submissionId: string; judgeUserId: string; scored: number; lastSavedAt: Date; criterionIds: string[]; scores: number[] }>>`
      SELECT s."id" AS "submissionId", x."judgeUserId", x."scored", x."lastSavedAt", x."criterionIds", x."scores"
      FROM "Submission" s
      CROSS JOIN LATERAL (
        -- Both arrays come from one aggregate pass, so their elements pair up.
        SELECT js."judgeUserId", count(*)::int AS "scored", max(js."updatedAt") AS "lastSavedAt", ${arrays}
        FROM "JudgeScore" js
        WHERE js."submissionId" = s."id"
        GROUP BY js."judgeUserId"
      ) x
      WHERE ${submitted}`,
    client.$queryRaw<Array<{ submissionId: string; judgeUserId: string; submittedAt: Date | null }>>`
      SELECT jr."submissionId", jr."judgeUserId", jr."submittedAt"
      FROM "JudgeReview" jr JOIN "Submission" s ON s."id" = jr."submissionId"
      WHERE ${submitted}`,
  ]);
  const pairs = new Map<string, JudgePairWork>();
  for (const row of scoreRows) {
    pairs.set(`${row.submissionId}\u0000${row.judgeUserId}`, {
      submissionId: row.submissionId,
      judgeUserId: row.judgeUserId,
      reviewed: false,
      submittedAt: null,
      scored: Number(row.scored),
      lastSavedAt: row.lastSavedAt,
      scores: new Map(row.criterionIds.map((criterionId, index) => [criterionId, Number(row.scores[index])])),
    });
  }
  for (const row of reviewRows) {
    const key = `${row.submissionId}\u0000${row.judgeUserId}`;
    const pair = pairs.get(key);
    if (pair) {
      pair.reviewed = true;
      pair.submittedAt = row.submittedAt;
    } else {
      pairs.set(key, { submissionId: row.submissionId, judgeUserId: row.judgeUserId, reviewed: true, submittedAt: row.submittedAt, scored: 0, lastSavedAt: null, scores: new Map() });
    }
  }
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...pairs.values()].sort((a, b) => byId(a.submissionId, b.submissionId) || byId(a.judgeUserId, b.judgeUserId));
}

/** Submitted reviews of SUBMITTED projects with their scores (eligibility and conflicts still to apply). */
export async function submittedReviewScores(client: Prisma.TransactionClient, eventId: string): Promise<CountedReview[]> {
  const pairs = await judgeWorkOnSubmitted(client, eventId, { withScores: true });
  return pairs.filter((pair) => pair.submittedAt != null).map((pair) => ({ submissionId: pair.submissionId, judgeUserId: pair.judgeUserId, scores: pair.scores }));
}

/** Conflicted (judge, project) pairs, found from each judge's own registrations: O(projects + conflict keys). */
export function conflictedPairs(projects: ReadonlyArray<{ id: string; teamId: string | null; rsvpId: string | null }>, conflicts: ReadonlyMap<string, ConflictKeys>): Set<string> {
  const byTeam = new Map<string, string>();
  const byRsvp = new Map<string, string>();
  for (const project of projects) {
    if (project.teamId) byTeam.set(project.teamId, project.id);
    if (project.rsvpId) byRsvp.set(project.rsvpId, project.id);
  }
  const blocked = new Set<string>();
  for (const [judgeUserId, keys] of conflicts) {
    for (const teamId of keys.teamIds) {
      const projectId = byTeam.get(teamId);
      if (projectId) blocked.add(pairKey(judgeUserId, projectId));
    }
    for (const rsvpId of keys.rsvpIds) {
      const projectId = byRsvp.get(rsvpId);
      if (projectId) blocked.add(pairKey(judgeUserId, projectId));
    }
  }
  return blocked;
}
