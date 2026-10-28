import "server-only";

/** Judging status, the ranking score method, and results publication. All audited. */

import { JudgingStatus, OutboxStatus, Prisma, ScoreNormalization } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import { shouldEmailOnPublish } from "@/lib/hackathonEmails";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { judgingStatusSchema, scoreNormalizationSchema } from "@/lib/validators";
import { CHANGED, fail, type JudgingResult, ok, okEmpty, withOrganiserLock } from "./shared";
import { queueResultsAnnouncement } from "./announcement";
import { judgingStatusFor, resolveJudgingRound, roundStatusFor } from "./rounds/scope";
import { ensureJudgingRound, syncCurrentRound } from "./rounds/sync";
import { changeRoundStatus } from "./rounds/status";
import { ineligibleAwardWinners } from "./rounds/awardEligibility";

// ---------------------------------------------------------------------------
// Judging status and results publication
// ---------------------------------------------------------------------------

/**
 * The current round's judging status (the event-level status mirrors it):
 * NOT_STARTED -> OPEN (needs a rubric), OPEN -> CLOSED (freezes scores),
 * CLOSED -> OPEN (only while results are unpublished), and back to
 * NOT_STARTED only before anyone has scored. The rules per round are in
 * `changeRoundStatus`. Audited (JUDGING_STATUS_CHANGED).
 */
export async function setJudgingStatus(ctx: JudgingOrganiserContext, status: unknown): Promise<JudgingResult<{ judgingStatus: JudgingStatus }>> {
  const parsed = judgingStatusSchema.safeParse(status);
  if (!parsed.success) return fail("Invalid judging status.");
  const next = parsed.data as JudgingStatus;
  return withOrganiserLock(ctx, async (tx, event) => {
    const round = await ensureJudgingRound(tx, event);
    const from = judgingStatusFor(round.status);
    if (from === next) return ok({ judgingStatus: from });
    const changed = await changeRoundStatus(tx, ctx, event, { ...round, id: round.id! }, roundStatusFor(next));
    return changed.ok ? ok({ judgingStatus: next }) : changed;
  });
}

/**
 * "Adjust for harsh/generous judges": which result score ranks the projects
 * (lib/judgingScore.ts). Both scores are always computed and shown to
 * organisers; this only picks the one that ranks, in the Results table, the
 * Awards picker, and the CSV's rank. It can change at any time, since ranks
 * only guide the organisers' manual award choices and public pages never
 * show scores or ranks. Audited (JUDGING_SCORE_NORMALIZATION_CHANGED).
 */
export async function setScoreNormalization(ctx: JudgingOrganiserContext, input: unknown): Promise<JudgingResult<{ scoreNormalization: ScoreNormalization }>> {
  const parsed = scoreNormalizationSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid score method.");
  const next = parsed.data as ScoreNormalization;
  return withOrganiserLock(ctx, async (tx, event) => {
    // The current round's method; the event-level field mirrors it.
    const round = await ensureJudgingRound(tx, event);
    const from = round.scoreNormalization;
    if (from === next) return ok({ scoreNormalization: next });
    if (round.finalizedAt) return fail("This round is finalised, so its score method can't change. Undo finalising first.");
    await tx.judgingRound.update({ where: { id: round.id! }, data: { scoreNormalization: next } });
    await syncCurrentRound(tx, event.id);
    await recordAuditEvent({
      client: tx,
      action: "JUDGING_SCORE_NORMALIZATION_CHANGED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: event.id,
      metadata: { from, to: next },
    });
    return ok({ scoreNormalization: next });
  });
}

/**
 * Publish results (judging must be CLOSED). Idempotent: publishing again while
 * published changes nothing and queues nothing. With more than one round,
 * the final round must be finalised first (a single round is unchanged), and
 * every award winner must be a finalist of the final round when it takes
 * advanced finalists (./rounds/awardEligibility.ts).
 *
 * Email is opt-in (`Event.emailEntrantsOnResults`, off by default; see
 * lib/hackathonEmails.ts), read under the Event lock at publish time:
 * - On: the first publication queues one `results-published` email per
 *   confirmed entrant member (every CONFIRMED registration of the event; team
 *   members share their team's status), deduplicated by address, and sets
 *   `resultsAnnouncedAt` to the publication time. A re-publication after an
 *   unpublish never emails an address a second time (see `unpublishResults`).
 * - Off: the results page goes live, nothing is queued, and
 *   `resultsAnnouncedAt` is left as it was: null on a first publication, or
 *   older than this publication after an earlier announcement. Either way
 *   the publication isn't covered (announcementCoversPublication), so
 *   `sendResultsAnnouncement` (./announcement.ts) can email the entrants not
 *   yet told later.
 * Audited (JUDGING_RESULTS_PUBLISHED).
 */
export type PublishResultsOutcome = { publishedAt: Date; queued: number; alreadyPublished: boolean; emailed: boolean };

export async function publishResults(ctx: JudgingOrganiserContext): Promise<JudgingResult<PublishResultsOutcome>> {
  return withOrganiserLock<PublishResultsOutcome>(ctx, async (tx, event) => {
    if (event.resultsPublishedAt) return ok({ publishedAt: event.resultsPublishedAt, queued: 0, alreadyPublished: true, emailed: false });
    if (!event.submissionsEnabled) return fail("This event is not taking project submissions.");
    if (event.judgingStatus !== JudgingStatus.CLOSED) return fail("Close judging before publishing results.");
    // Results come from the final round: a round still to judge after the current one blocks publication.
    const round = await resolveJudgingRound(tx, event);
    if (round && !round.isFinal) return fail("A later judging round hasn't been judged yet. Open and close it, or delete it, before publishing results.");
    if (round && round.roundCount > 1 && !round.finalizedAt) return fail(`Finalise “${round.name}” before publishing results.`);
    const ineligible = await ineligibleAwardWinners(tx, event.id);
    if (ineligible > 0) {
      return fail(`${ineligible === 1 ? "An award winner isn't" : `${ineligible} award winners aren't`} in the final round. Remove ${ineligible === 1 ? "it" : "them"} or pick finalists before publishing results.`);
    }
    const publishedAt = new Date();
    const emailed = shouldEmailOnPublish(event);
    const firstAnnouncement = !event.resultsAnnouncedAt;
    const updated = await tx.event.updateMany({
      where: { id: event.id, resultsPublishedAt: null },
      data: { resultsPublishedAt: publishedAt, ...(emailed ? { resultsAnnouncedAt: publishedAt } : {}) },
    });
    if (updated.count !== 1) return fail(CHANGED);
    const queued = emailed ? await queueResultsAnnouncement(tx, event.id, firstAnnouncement) : 0;
    await recordAuditEvent({
      client: tx,
      action: "JUDGING_RESULTS_PUBLISHED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: event.id,
      metadata: { recipients: queued, republished: !firstAnnouncement, emailEntrantsOnResults: emailed },
    });
    return ok({ publishedAt, queued, alreadyPublished: false, emailed });
  });
}

/**
 * Hide the results page again. Undelivered announcements for this event are
 * withdrawn. When none had been delivered, the announcement counts as never
 * made (`resultsAnnouncedAt` is cleared), so the next publication emails
 * everyone; otherwise it emails only those whose copy was withdrawn, and
 * nobody gets the announcement twice. Audited.
 */
export async function unpublishResults(ctx: JudgingOrganiserContext): Promise<JudgingResult> {
  return withOrganiserLock(ctx, async (tx, event) => {
    if (!event.resultsPublishedAt) return okEmpty();
    const announcement = { kind: "results-published", payload: { path: ["eventId"], equals: event.id } } satisfies Prisma.OutboxMessageWhereInput;
    const withdrawn = await tx.outboxMessage.deleteMany({ where: { ...announcement, status: OutboxStatus.PENDING } });
    const delivered = withdrawn.count > 0 ? await tx.outboxMessage.count({ where: announcement }) : 1;
    await tx.event.update({
      where: { id: event.id },
      data: { resultsPublishedAt: null, ...(delivered === 0 ? { resultsAnnouncedAt: null } : {}) },
    });
    await recordAuditEvent({
      client: tx,
      action: "JUDGING_RESULTS_UNPUBLISHED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: event.id,
    });
    return okEmpty();
  });
}
