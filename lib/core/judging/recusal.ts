import "server-only";

/**
 * Judge self-recusal (docs/HACKATHON.md "Recusal", as Space Works judging
 * has it): a judge steps away from a project they were assigned in the open
 * round, for example over a conflict the organisers don't know about. The
 * assignment row stays with `recusedAt` set, so the organisers see it: the
 * project leaves the judge's list (visibility), is never assigned to them
 * again in that round, and doesn't count towards coverage, like a missing
 * review. A judge can undo it while the round is open. Not once they have
 * submitted a review of it: that is the organisers' call.
 */

import { JudgingRoundStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { pairKey } from "@/lib/judgingAssignment";
import type { JudgeContext } from "@/lib/judgingAccess";
import { EVENT_NOT_FOUND, fail, JUDGING_NOT_OPEN, type JudgingResult, lockEventShared, NOT_FOUND, ok, refuse } from "./shared";
import { isRoundJudge } from "./judges";
import { type JudgingRoundScope, resolveJudgingRound, roundProjectsWhere } from "./rounds/scope";

const recusalSchema = z.object({ submissionId: z.string().min(1).max(128) }).strict();

type RecusalRound = Pick<JudgingRoundScope, "id">;

/** `pairKey(judge, project)` of every recused assignment in the round: pairs nobody may assign or count. */
export async function recusedPairs(client: Prisma.TransactionClient, round: RecusalRound): Promise<Set<string>> {
  if (!round.id) return new Set();
  const rows = await client.judgeAssignment.findMany({ where: { roundId: round.id, recusedAt: { not: null } }, select: { judgeUserId: true, submissionId: true } });
  return new Set(rows.map((row) => pairKey(row.judgeUserId, row.submissionId)));
}

/** Prisma condition on a Submission: this judge hasn't recused from it in the round. */
export function notRecusedWhere(round: RecusalRound, judgeUserId: string): Prisma.SubmissionWhereInput {
  return { assignments: { none: { judgeUserId, roundId: round.id ?? "", recusedAt: { not: null } } } };
}

/** The same rule in SQL, on `"Submission" s`. */
export function notRecusedSql(round: RecusalRound, judgeUserId: string): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (SELECT 1 FROM "JudgeAssignment" jx WHERE jx."submissionId" = s."id" AND jx."judgeUserId" = ${judgeUserId} AND jx."roundId" = ${round.id} AND jx."recusedAt" IS NOT NULL)`;
}

export type RecusedProjectDto = { submissionId: string; title: string };

/** The judge's recusals in a round (for "Undo"), bounded by their assignments there. */
export async function listJudgeRecusals(ctx: JudgeContext, round: Pick<JudgingRoundScope, "id" | "eventId" | "entrySource">): Promise<RecusedProjectDto[]> {
  if (!round.id) return [];
  const rows = await prisma.judgeAssignment.findMany({
    where: { roundId: round.id, judgeUserId: ctx.userId, recusedAt: { not: null }, submission: roundProjectsWhere(round) },
    orderBy: [{ recusedAt: "asc" }, { submissionId: "asc" }],
    select: { submissionId: true, submission: { select: { title: true } } },
  });
  return rows.map((row) => ({ submissionId: row.submissionId, title: row.submission.title }));
}

/**
 * Recuse from (`recused` true) or return to (false) an assigned project in
 * the open round, under the Event share lock like scoring. Idempotent.
 * Audited (JUDGE_RECUSED, JUDGE_RECUSAL_WITHDRAWN).
 */
export async function setJudgeRecusal(ctx: JudgeContext, input: unknown, recused: boolean): Promise<JudgingResult<{ recused: boolean }>> {
  const parsed = recusalSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input.");
  const { submissionId } = parsed.data;
  return prisma.$transaction(async (tx): Promise<JudgingResult<{ recused: boolean }>> => {
    const event = await lockEventShared(tx, ctx.eventId);
    if (!event || event.organisationId !== ctx.organisationId || !event.submissionsEnabled) return fail(EVENT_NOT_FOUND);
    const round = await resolveJudgingRound(tx, event);
    if (!round?.id || !(await isRoundJudge(tx, round, event.organisationId, ctx.userId))) return fail(NOT_FOUND);
    if (round.status !== JudgingRoundStatus.OPEN) return refuse(JUDGING_NOT_OPEN, "JUDGING_CLOSED");
    const assignment = await tx.judgeAssignment.findFirst({
      where: { roundId: round.id, judgeUserId: ctx.userId, submissionId, submission: roundProjectsWhere(round) },
      select: { id: true, recusedAt: true },
    });
    if (!assignment) return refuse("You can only recuse yourself from a project you're assigned to in this round.", "NOT_VISIBLE");
    if (Boolean(assignment.recusedAt) === recused) return ok({ recused });
    if (recused) {
      const submitted = await tx.judgeReview.count({ where: { roundId: round.id, submissionId, judgeUserId: ctx.userId, submittedAt: { not: null } } });
      if (submitted > 0) return fail("You've already submitted a review of this project. Ask the organisers if it shouldn't count.");
    }
    await tx.judgeAssignment.update({ where: { id: assignment.id }, data: { recusedAt: recused ? new Date() : null } });
    await recordAuditEvent({
      client: tx,
      action: recused ? "JUDGE_RECUSED" : "JUDGE_RECUSAL_WITHDRAWN",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Submission",
      targetId: submissionId,
      metadata: { eventId: event.id, round: round.position },
    });
    return ok({ recused });
  });
}
