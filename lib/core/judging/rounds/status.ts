import "server-only";

/** Opening, closing and resetting a judging round (docs/HACKATHON.md "Rounds"). Audited. */

import { JudgingRoundEntrySource, JudgingRoundStatus, Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { CHANGED, fail, type JudgingEvent, type JudgingResult, okEmpty } from "../shared";
import { judgingStatusFor, type JudgingRoundScope } from "./scope";
import { syncCurrentRound } from "./sync";

/** Why `round` can't move to `next`, or null when it can. Read inside the organiser's Event lock. */
async function statusRefusal(tx: Prisma.TransactionClient, event: JudgingEvent, round: JudgingRoundScope & { id: string }, next: JudgingRoundStatus): Promise<string | null> {
  const from = round.status;
  if (round.finalizedAt) return "This round is finalised, so its judging can't reopen or reset.";
  const others = await tx.judgingRound.findMany({ where: { eventId: event.id, id: { not: round.id } }, select: { name: true, position: true, status: true } });
  const laterStarted = others.some((other) => other.position > round.position && other.status !== JudgingRoundStatus.DRAFT);
  if (next === JudgingRoundStatus.OPEN) {
    if (!event.submissionsEnabled) return "Turn on submissions first.";
    if (event.resultsPublishedAt) return "Unpublish the results before reopening judging.";
    const criteria = await tx.judgingCriterion.count({ where: { roundId: round.id } });
    if (criteria === 0) return "Add at least one rubric criterion before opening judging.";
    const earlierOpen = others.find((other) => other.position < round.position && other.status !== JudgingRoundStatus.CLOSED);
    if (earlierOpen) return `Close “${earlierOpen.name}” before opening this round.`;
    if (laterStarted) return "A later round has already opened, so this round can't reopen.";
    if (round.entrySource === JudgingRoundEntrySource.ADVANCED && (await tx.judgingRoundEntry.count({ where: { roundId: round.id } })) === 0) {
      return "Advance finalists into this round before opening it.";
    }
    return null;
  }
  if (next === JudgingRoundStatus.CLOSED) return from === JudgingRoundStatus.OPEN ? null : "Only open judging can be closed.";
  const [scores, reviews] = await Promise.all([
    tx.judgeScore.count({ where: { criterion: { roundId: round.id } } }),
    tx.judgeReview.count({ where: { roundId: round.id } }),
  ]);
  if (scores > 0 || reviews > 0) return "Judges have already scored, so judging can't be reset.";
  if (event.resultsPublishedAt) return "Unpublish the results first.";
  if (laterStarted) return "A later round has already opened, so this round can't be reset.";
  return null;
}

/**
 * DRAFT -> OPEN (needs a rubric; earlier rounds closed; an ADVANCED round
 * needs its finalists), OPEN -> CLOSED (freezes scores), CLOSED -> OPEN (only
 * while results are unpublished and no later round has opened), and back to
 * DRAFT only before anyone has scored. The event's current round and its
 * mirrored fields follow. Audited (JUDGING_STATUS_CHANGED, with the round's
 * position once the event has more than one round).
 */
export async function changeRoundStatus(
  tx: Prisma.TransactionClient,
  ctx: JudgingOrganiserContext,
  event: JudgingEvent,
  round: JudgingRoundScope & { id: string },
  next: JudgingRoundStatus,
): Promise<JudgingResult> {
  const from = round.status;
  if (from === next) return okEmpty();
  const refusal = await statusRefusal(tx, event, round, next);
  if (refusal) return fail(refusal);
  const updated = await tx.judgingRound.updateMany({ where: { id: round.id, eventId: event.id, status: from }, data: { status: next } });
  if (updated.count !== 1) return fail(CHANGED);
  await syncCurrentRound(tx, event.id);
  await recordAuditEvent({
    client: tx,
    action: "JUDGING_STATUS_CHANGED",
    actorUserId: ctx.userId,
    organisationId: ctx.organisationId,
    targetType: "Event",
    targetId: event.id,
    metadata: { from: judgingStatusFor(from), to: judgingStatusFor(next), ...(round.roundCount > 1 ? { round: round.position } : {}) },
  });
  return okEmpty();
}
