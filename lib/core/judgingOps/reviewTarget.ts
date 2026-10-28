import "server-only";

/** The per-project review target (judges per project). Audited. */

import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import type { JudgingResult } from "@/lib/core/judging";
import { reviewsPerProjectSchema } from "@/lib/judgingProgress";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { EVENT_NOT_FOUND, fail, lockOpsEvent, ok } from "./shared";
import { ensureJudgingRound, syncCurrentRound } from "@/lib/core/judging/rounds/sync";

// ---------------------------------------------------------------------------
// Review target
// ---------------------------------------------------------------------------

/**
 * Set (or clear, with null or "") the target number of judges per project
 * used by the Progress dashboard and as the automatic assignment default, on
 * the current round (the event-level field mirrors it).
 * Audited (JUDGING_REVIEW_TARGET_UPDATED).
 */
export async function setReviewsPerProject(ctx: JudgingOrganiserContext, input: unknown): Promise<JudgingResult<{ reviewsPerProject: number | null }>> {
  let value: number | null = null;
  if (input !== null && input !== "" && input !== undefined) {
    const parsed = reviewsPerProjectSchema.safeParse(input);
    if (!parsed.success) return fail("Choose between 1 and 20 judges per project.", { reviewsPerProject: ["Choose between 1 and 20 judges per project."] });
    value = parsed.data;
  }
  return prisma.$transaction(async (tx): Promise<JudgingResult<{ reviewsPerProject: number | null }>> => {
    const event = await lockOpsEvent(tx, ctx);
    if (!event) return fail(EVENT_NOT_FOUND);
    const round = await ensureJudgingRound(tx, event);
    if (round.reviewsPerProject === value) return ok({ reviewsPerProject: value });
    if (round.finalizedAt) return fail("This round is finalised, so its target can't change. Undo finalising first.");
    await tx.judgingRound.update({ where: { id: round.id! }, data: { reviewsPerProject: value } });
    await syncCurrentRound(tx, event.id);
    await recordAuditEvent({
      client: tx,
      action: "JUDGING_REVIEW_TARGET_UPDATED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: event.id,
      metadata: { from: round.reviewsPerProject, to: value },
    });
    return ok({ reviewsPerProject: value });
  });
}
