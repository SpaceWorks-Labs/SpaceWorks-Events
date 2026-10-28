import "server-only";

/**
 * Finalising a round (docs/HACKATHON.md "Rounds", from the Space Works
 * judging design): a CLOSED round is finalised once every project it judges
 * has the review target's number of counted reviews, or with an organiser's
 * exception reason when some fall short. Missing reviews are never counted
 * as zero; a short project simply has fewer counted judges. A finalised round
 * can't reopen or reset, and finalists advance only from a finalised round.
 * Finalising freezes which reviews count (JudgingRoundCountedReview): the
 * round's results, CSV and advancement read that snapshot from then on, so a
 * later grant, panel or conflict change doesn't move a finalised ranking.
 * Finalising is separate from publishing results.
 */

import { JudgingRoundStatus, SubmissionStatus } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { effectiveReviewTarget } from "@/lib/judgingProgress";
import { FINALIZE_REASON_MAX_LENGTH } from "@/lib/validators/judgingRounds";
import { fail, isId, type JudgingResult, ok, okEmpty, withOrganiserLock } from "../shared";
import { loadJudgingResults } from "../results";
import { resolveJudgingRound } from "./scope";

const ROUND_NOT_FOUND = "Judging round not found.";
export { FINALIZE_REASON_MAX_LENGTH };

export type RoundCoverageDto = { projects: number; target: number; short: number };

function reasonFrom(input: unknown): string | null {
  const value = typeof input === "object" && input !== null ? (input as { reason?: unknown }).reason : undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return trimmed ? trimmed.slice(0, FINALIZE_REASON_MAX_LENGTH) : null;
}

/**
 * Finalise a CLOSED round. When projects are short of the target, a reason
 * is required and stored with the round (organisers only). Audited
 * (JUDGING_ROUND_FINALIZED, counts and whether an exception was used).
 */
export async function finalizeJudgingRound(ctx: JudgingOrganiserContext, roundId: unknown, input: unknown = {}): Promise<JudgingResult<RoundCoverageDto>> {
  if (!isId(roundId)) return fail(ROUND_NOT_FOUND);
  const reason = reasonFrom(input);
  return withOrganiserLock(ctx, async (tx, event) => {
    const round = await resolveJudgingRound(tx, event, roundId);
    if (!round?.id) return fail(ROUND_NOT_FOUND);
    if (round.status !== JudgingRoundStatus.CLOSED) return fail("Close this round before finalising it.");
    const target = effectiveReviewTarget(round.reviewsPerProject);
    // Scores are frozen while the round is closed and the Event lock is held.
    const results = await loadJudgingResults(ctx, { roundId: round.id });
    if (!results) return fail(ROUND_NOT_FOUND);
    const projects = results.rows.filter((row) => row.status === SubmissionStatus.SUBMITTED);
    const short = projects.filter((row) => row.judgesCounted < target).length;
    const coverage = { projects: projects.length, target, short };
    if (round.finalizedAt) return ok(coverage);
    if (short > 0 && !reason) {
      const message = `${short} ${short === 1 ? "project has" : "projects have"} fewer than ${target} counted reviews. Give a reason to finalise anyway.`;
      return fail(message, { reason: [message] });
    }
    const now = new Date();
    await tx.judgingRound.update({ where: { id: round.id }, data: { finalizedAt: now, finalizeExceptionReason: short > 0 ? reason : null, countedFrozenAt: now } });
    await tx.judgingRoundCountedReview.deleteMany({ where: { roundId: round.id } });
    await tx.judgingRoundCountedReview.createMany({
      data: results.countedReviewKeys.map((key) => {
        const [submissionId, judgeUserId] = key.split("\u0000") as [string, string];
        return { roundId: round.id!, submissionId, judgeUserId };
      }),
      skipDuplicates: true,
    });
    await recordAuditEvent({
      client: tx,
      action: "JUDGING_ROUND_FINALIZED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: event.id,
      metadata: { round: round.position, projects: projects.length, short, exception: short > 0, countedReviews: results.countedReviewKeys.length },
    });
    return ok(coverage);
  });
}

/** Undo finalising, while no later round holds finalists advanced from it; its counted reviews go live again. Audited. */
export async function unfinalizeJudgingRound(ctx: JudgingOrganiserContext, roundId: unknown): Promise<JudgingResult> {
  if (!isId(roundId)) return fail(ROUND_NOT_FOUND);
  return withOrganiserLock(ctx, async (tx, event) => {
    const round = await resolveJudgingRound(tx, event, roundId);
    if (!round?.id) return fail(ROUND_NOT_FOUND);
    if (!round.finalizedAt) return okEmpty();
    const next = await tx.judgingRound.findFirst({ where: { eventId: event.id, position: round.position + 1 }, select: { status: true, _count: { select: { entries: true } } } });
    if (next && (next._count.entries > 0 || next.status !== JudgingRoundStatus.DRAFT)) return fail("Finalists have already advanced from this round, so it stays finalised.");
    await tx.judgingRound.update({ where: { id: round.id }, data: { finalizedAt: null, finalizeExceptionReason: null, countedFrozenAt: null } });
    await tx.judgingRoundCountedReview.deleteMany({ where: { roundId: round.id } });
    await recordAuditEvent({ client: tx, action: "JUDGING_ROUND_UNFINALIZED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: event.id, metadata: { round: round.position } });
    return okEmpty();
  });
}
