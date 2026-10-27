import "server-only";

/** Judging status, the ranking score method, and results publication. All audited. */

import { JudgingStatus, OutboxStatus, Prisma, RsvpStatus, ScoreNormalization } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import { asResultsPublishedPayload, enqueueResultsPublished } from "@/lib/outbox";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { judgingStatusSchema, scoreNormalizationSchema } from "@/lib/validators";
import { CHANGED, fail, type JudgingResult, ok, okEmpty, personEmail, personName, personSelect, withOrganiserLock } from "./shared";
import { judgingStatusFor, resolveJudgingRound, roundStatusFor } from "./rounds/scope";
import { ensureJudgingRound, syncCurrentRound } from "./rounds/sync";
import { changeRoundStatus } from "./rounds/status";

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
 * published changes nothing and queues nothing. The first publication queues
 * one `results-published` email per confirmed entrant member (every CONFIRMED
 * registration of the event; team members share their team's status),
 * deduplicated by address, and records `resultsAnnouncedAt`. A re-publication
 * after an unpublish never emails an address a second time (see
 * `unpublishResults`). Audited (JUDGING_RESULTS_PUBLISHED).
 */
export type PublishResultsOutcome = { publishedAt: Date; queued: number; alreadyPublished: boolean };

export async function publishResults(ctx: JudgingOrganiserContext): Promise<JudgingResult<PublishResultsOutcome>> {
  return withOrganiserLock<PublishResultsOutcome>(ctx, async (tx, event) => {
    if (event.resultsPublishedAt) return ok({ publishedAt: event.resultsPublishedAt, queued: 0, alreadyPublished: true });
    if (!event.submissionsEnabled) return fail("This event is not taking project submissions.");
    if (event.judgingStatus !== JudgingStatus.CLOSED) return fail("Close judging before publishing results.");
    // Results come from the final round: a round still to judge after the current one blocks publication.
    const round = await resolveJudgingRound(tx, event);
    if (round && !round.isFinal) return fail("A later judging round hasn't been judged yet. Open and close it, or delete it, before publishing results.");
    const publishedAt = new Date();
    const announced = await tx.event.findUnique({ where: { id: event.id }, select: { resultsAnnouncedAt: true } });
    const firstAnnouncement = !announced?.resultsAnnouncedAt;
    const updated = await tx.event.updateMany({
      where: { id: event.id, resultsPublishedAt: null },
      data: { resultsPublishedAt: publishedAt, ...(firstAnnouncement ? { resultsAnnouncedAt: publishedAt } : {}) },
    });
    if (updated.count !== 1) return fail(CHANGED);

    // After an earlier announcement, only addresses whose copy was withdrawn
    // undelivered by the unpublish are emailed: anyone with a delivered (or
    // in-flight) announcement left in the outbox is skipped, and once those
    // rows have aged out nobody is emailed again.
    let alreadyTold: Set<string> | null = null;
    if (!firstAnnouncement) {
      const previous = await tx.outboxMessage.findMany({
        where: { kind: "results-published", payload: { path: ["eventId"], equals: event.id } },
        select: { payload: true },
      });
      alreadyTold = new Set(previous.map((row) => asResultsPublishedPayload(row.payload)?.to.toLowerCase()).filter((to): to is string => Boolean(to)));
    }
    const recipients = alreadyTold?.size === 0 ? [] : await tx.rSVP.findMany({
      where: { eventId: event.id, status: RsvpStatus.CONFIRMED },
      select: personSelect,
      orderBy: { createdAt: "asc" },
    });
    const seen = new Set<string>(alreadyTold ?? []);
    const payloads: Array<{ to: string; eventId: string; recipientName?: string }> = [];
    for (const person of recipients) {
      const email = personEmail(person)?.toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      const name = personName(person)?.slice(0, 200);
      payloads.push({ to: email, eventId: event.id, ...(name ? { recipientName: name } : {}) });
    }
    await enqueueResultsPublished(tx, payloads);
    await recordAuditEvent({
      client: tx,
      action: "JUDGING_RESULTS_PUBLISHED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: event.id,
      metadata: { recipients: payloads.length, republished: !firstAnnouncement },
    });
    return ok({ publishedAt, queued: payloads.length, alreadyPublished: false });
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
