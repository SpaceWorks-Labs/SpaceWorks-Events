import "server-only";

/** Judge writes: save scores and submit a review in the current round, under the Event share lock. */

import crypto from "node:crypto";
import { JudgingRoundStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sqlUtcTimestamp, SQL_UTC_NOW } from "@/lib/sqlTimestamp";
import type { JudgeContext } from "@/lib/judgingAccess";
import { judgeReviewSchema, judgeScoresSchema } from "@/lib/validators";
import { criteriaFor, EVENT_NOT_FOUND, fail, invalid, JUDGING_NOT_OPEN, type JudgingResult, lockEventShared, NOT_FOUND, ok, refuse } from "./shared";
import { isRoundJudge } from "./judges";
import { visibleSubmissionIds } from "./judgeVisibility";
import { type JudgingRoundScope, resolveJudgingRound } from "./rounds/scope";

/**
 * The round a request pinned before its writes (a mobile `?roundId=`, or the
 * round the request's first write used): `undefined` pins nothing, `null`
 * expects no round yet. Compared after the Event lock, so a round switched
 * mid-request is refused rather than written to.
 */
export type ExpectedRound = string | null | undefined;

export const ROUND_CHANGED = "Scores are saved to the current round only.";

/**
 * Lock the event, then confirm the current round is open and this judge may
 * score this submission in it. Judges only ever write to the current round:
 * the one OPEN round, which the event-level judging status mirrors.
 */
async function lockedJudgeTarget(tx: Prisma.TransactionClient, ctx: JudgeContext, submissionId: string, expectedRoundId: ExpectedRound): Promise<JudgingResult<{ round: JudgingRoundScope & { id: string } }>> {
  const event = await lockEventShared(tx, ctx.eventId);
  if (!event || event.organisationId !== ctx.organisationId || !event.submissionsEnabled) return fail(EVENT_NOT_FOUND);
  const round = await resolveJudgingRound(tx, event);
  if (expectedRoundId !== undefined && (round?.id ?? null) !== expectedRoundId) return refuse(ROUND_CHANGED, "JUDGING_CLOSED");
  if (!round || !(await isRoundJudge(tx, round, event.organisationId, ctx.userId))) return fail(NOT_FOUND);
  if (round.status !== JudgingRoundStatus.OPEN || !round.id) return refuse(JUDGING_NOT_OPEN, "JUDGING_CLOSED");
  const visible = await visibleSubmissionIds(tx, round, ctx.userId, submissionId);
  if (!visible.includes(submissionId)) return refuse(NOT_FOUND, "NOT_VISIBLE");
  return ok({ round: { ...round, id: round.id } });
}

/**
 * Save some or all scores for one submission. Each score is a whole number in
 * 0..maxScore for a criterion of the open round. Upserts on the unique
 * (submission, judge, criterion) key, so concurrent saves never duplicate.
 */
export async function saveJudgeScores(ctx: JudgeContext, input: unknown, expectedRoundId?: ExpectedRound): Promise<JudgingResult<{ scored: number; total: number; roundId: string }>> {
  const parsed = judgeScoresSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { submissionId, scores } = parsed.data;
  return prisma.$transaction(async (tx): Promise<JudgingResult<{ scored: number; total: number; roundId: string }>> => {
    const target = await lockedJudgeTarget(tx, ctx, submissionId, expectedRoundId);
    if (!target.ok) return target;
    const criteria = await criteriaFor(tx, target.data.round);
    const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
    for (const entry of scores) {
      const criterion = byId.get(entry.criterionId);
      if (!criterion) return fail("Unknown criterion.");
      if (entry.score > criterion.maxScore) return fail(`Scores for “${criterion.name}” go up to ${criterion.maxScore}.`);
    }
    for (const entry of scores) {
      await tx.$executeRaw`
        INSERT INTO "JudgeScore" ("id", "submissionId", "judgeUserId", "criterionId", "score", "createdAt", "updatedAt")
        VALUES (${crypto.randomUUID()}, ${submissionId}, ${ctx.userId}, ${entry.criterionId}, ${entry.score}, ${SQL_UTC_NOW}, ${SQL_UTC_NOW})
        ON CONFLICT ("submissionId", "judgeUserId", "criterionId")
        DO UPDATE SET "score" = EXCLUDED."score", "updatedAt" = ${SQL_UTC_NOW}`;
    }
    const scored = await tx.judgeScore.count({ where: { submissionId, judgeUserId: ctx.userId, criterionId: { in: criteria.map((c) => c.id) } } });
    return ok({ scored, total: criteria.length, roundId: target.data.round.id });
  });
}

/**
 * Save the judge's private comment, and with `submit` (the default) mark the
 * review complete. Submitting needs every criterion scored. Upserts on the
 * unique (round, submission, judge) key.
 */
export async function submitJudgeReview(ctx: JudgeContext, input: unknown, expectedRoundId?: ExpectedRound): Promise<JudgingResult<{ submitted: boolean }>> {
  const parsed = judgeReviewSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { submissionId, comment, submit } = parsed.data;
  return prisma.$transaction(async (tx): Promise<JudgingResult<{ submitted: boolean }>> => {
    const target = await lockedJudgeTarget(tx, ctx, submissionId, expectedRoundId);
    if (!target.ok) return target;
    const { round } = target.data;
    if (submit) {
      const criteria = await criteriaFor(tx, round);
      if (criteria.length === 0) return refuse("This event has no rubric yet.", "INCOMPLETE_SCORES");
      const scored = await tx.judgeScore.count({ where: { submissionId, judgeUserId: ctx.userId, criterionId: { in: criteria.map((c) => c.id) } } });
      if (scored < criteria.length) return refuse("Score every criterion before submitting your review.", "INCOMPLETE_SCORES");
    }
    const submittedAt = submit ? new Date() : null;
    await tx.$executeRaw`
      INSERT INTO "JudgeReview" ("id", "roundId", "submissionId", "judgeUserId", "comment", "submittedAt", "createdAt", "updatedAt")
      VALUES (${crypto.randomUUID()}, ${round.id}, ${submissionId}, ${ctx.userId}, ${comment}, ${sqlUtcTimestamp(submittedAt)}, ${SQL_UTC_NOW}, ${SQL_UTC_NOW})
      ON CONFLICT ("roundId", "submissionId", "judgeUserId")
      DO UPDATE SET "comment" = EXCLUDED."comment",
                    "submittedAt" = COALESCE(EXCLUDED."submittedAt", "JudgeReview"."submittedAt"),
                    "updatedAt" = ${SQL_UTC_NOW}`;
    const review = await tx.judgeReview.findUnique({ where: { roundId_submissionId_judgeUserId: { roundId: round.id, submissionId, judgeUserId: ctx.userId } }, select: { submittedAt: true } });
    return ok({ submitted: Boolean(review?.submittedAt) });
  });
}
