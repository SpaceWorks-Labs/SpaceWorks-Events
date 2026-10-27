import "server-only";

/** Judging status, the ranking score method, and results publication. All audited. */

import { JudgingStatus, OutboxStatus, Prisma, ScoreNormalization } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import { shouldEmailOnPublish } from "@/lib/hackathonEmails";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { judgingStatusSchema, scoreNormalizationSchema } from "@/lib/validators";
import { CHANGED, fail, type JudgingResult, ok, okEmpty, withOrganiserLock } from "./shared";
import { queueResultsAnnouncement } from "./announcement";

// ---------------------------------------------------------------------------
// Judging status and results publication
// ---------------------------------------------------------------------------

/**
 * NOT_STARTED -> OPEN (needs a rubric), OPEN -> CLOSED (freezes scores),
 * CLOSED -> OPEN (only while results are unpublished), and back to
 * NOT_STARTED only before anyone has scored. Audited (JUDGING_STATUS_CHANGED).
 */
export async function setJudgingStatus(ctx: JudgingOrganiserContext, status: unknown): Promise<JudgingResult<{ judgingStatus: JudgingStatus }>> {
  const parsed = judgingStatusSchema.safeParse(status);
  if (!parsed.success) return fail("Invalid judging status.");
  const next = parsed.data as JudgingStatus;
  return withOrganiserLock(ctx, async (tx, event) => {
    const from = event.judgingStatus;
    if (from === next) return ok({ judgingStatus: from });
    if (next === JudgingStatus.OPEN) {
      if (!event.submissionsEnabled) return fail("Turn on submissions first.");
      if (event.resultsPublishedAt) return fail("Unpublish the results before reopening judging.");
      const criteria = await tx.judgingCriterion.count({ where: { eventId: event.id } });
      if (criteria === 0) return fail("Add at least one rubric criterion before opening judging.");
    } else if (next === JudgingStatus.CLOSED) {
      if (from !== JudgingStatus.OPEN) return fail("Only open judging can be closed.");
    } else {
      const [scores, reviews] = await Promise.all([
        tx.judgeScore.count({ where: { submission: { eventId: event.id } } }),
        tx.judgeReview.count({ where: { submission: { eventId: event.id } } }),
      ]);
      if (scores > 0 || reviews > 0) return fail("Judges have already scored, so judging can't be reset.");
      if (event.resultsPublishedAt) return fail("Unpublish the results first.");
    }
    const updated = await tx.event.updateMany({ where: { id: event.id, judgingStatus: from }, data: { judgingStatus: next } });
    if (updated.count !== 1) return fail(CHANGED);
    await recordAuditEvent({
      client: tx,
      action: "JUDGING_STATUS_CHANGED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: event.id,
      metadata: { from, to: next },
    });
    return ok({ judgingStatus: next });
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
    const current = await tx.event.findUnique({ where: { id: event.id }, select: { scoreNormalization: true } });
    const from = current?.scoreNormalization ?? ScoreNormalization.RAW;
    if (from === next) return ok({ scoreNormalization: next });
    await tx.event.update({ where: { id: event.id }, data: { scoreNormalization: next } });
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
 * published changes nothing and queues nothing.
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
