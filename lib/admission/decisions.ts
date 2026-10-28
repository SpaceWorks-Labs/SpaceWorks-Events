import "server-only";

import { AdmissionBatchStatus, AdmissionDecisionOutcome, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import type { WebhookEmission } from "@/lib/webhooks/emit";
import type { AdmissionContext } from "./access";
import { stageCoverage } from "./coverage";
import { emitAll } from "./notify";
import { allowedOutcomes, coverageMet, offerCeiling, offersLeft } from "./rules";
import { AdmissionError, applicationSelect, countOfferHolding, lockAdmissionEvent, type ApplicationRow } from "./state";
import { advanceApplication, offerPlace, rejectApplication, waitlistApplication } from "./transitions";

/*
 * Decisions (docs/ADMISSION.md "Decisions"). Organisers draft decisions into
 * the event's one DRAFT batch, then release or cancel the batch as a whole.
 * Release re-checks everything under the Event lock and changes nothing
 * unless every decision passes:
 * - the application hasn't changed since the decision was drafted (version);
 * - the outcome still fits its status and stage;
 * - the stage's review target is met by counted reviews, or the decision has
 *   an override reason;
 * - the offers fit the offer capacity (offered + accepted, capacity else).
 */

export type DecisionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });

export type DraftInput = { applicationIds: string[]; outcome: AdmissionDecisionOutcome; note?: string; overrideReason?: string | null; sourceRank?: number | null };

async function draftBatch(tx: Prisma.TransactionClient, eventId: string) {
  const existing = await tx.admissionDecisionBatch.findFirst({ where: { eventId, status: AdmissionBatchStatus.DRAFT }, select: { id: true } });
  return existing ?? tx.admissionDecisionBatch.create({ data: { eventId }, select: { id: true } });
}

async function nextStageIds(tx: Prisma.TransactionClient, eventId: string): Promise<Map<string, boolean>> {
  const stages = await tx.admissionStage.findMany({ where: { eventId }, select: { id: true, position: true } });
  const last = Math.max(0, ...stages.map((stage) => stage.position));
  return new Map(stages.map((stage) => [stage.id, stage.position < last]));
}

/** Draft (or replace) the decision for each application. */
export async function draftDecisions(ctx: AdmissionContext, input: DraftInput): Promise<DecisionResult<{ drafted: number }>> {
  const ids = [...new Set(input.applicationIds)];
  return prisma.$transaction(async (tx) => {
    const event = await lockAdmissionEvent(tx, ctx.eventId, ctx.organisationId);
    if (!event?.admissionEnabled) return fail("Applications are off for this event.");
    const apps = await tx.admissionApplication.findMany({ where: { id: { in: ids }, eventId: event.id }, select: applicationSelect });
    if (apps.length !== ids.length) return fail("Some of these applications are no longer here. Refresh and try again.");
    const hasNext = await nextStageIds(tx, event.id);
    for (const app of apps) {
      if (!allowedOutcomes(app.status, Boolean(app.currentStageId && hasNext.get(app.currentStageId))).includes(input.outcome)) {
        return fail(input.outcome === "ADVANCE" ? "Only applications in review before the last stage can move on." : "That decision doesn't fit one of these applications any more.");
      }
      if (!app.currentStageId) return fail("Add a stage before deciding.");
    }
    const batch = await draftBatch(tx, event.id);
    await tx.admissionDecision.deleteMany({ where: { batchId: batch.id, applicationId: { in: ids } } });
    await tx.admissionDecision.createMany({
      data: apps.map((app) => ({
        batchId: batch.id,
        applicationId: app.id,
        stageId: app.currentStageId!,
        outcome: input.outcome,
        expectedVersion: app.version,
        note: input.note?.trim() ?? "",
        overrideReason: input.overrideReason?.trim() || null,
        sourceRank: input.sourceRank ?? null,
        createdByUserId: ctx.userId,
      })),
    });
    return { ok: true as const, data: { drafted: apps.length } };
  });
}

export async function removeDraftDecisions(ctx: AdmissionContext, applicationIds: string[]): Promise<DecisionResult<{ removed: number }>> {
  const removed = await prisma.admissionDecision.deleteMany({ where: { applicationId: { in: applicationIds }, batch: { eventId: ctx.eventId, status: AdmissionBatchStatus.DRAFT, event: { organisationId: ctx.organisationId } } } });
  return { ok: true, data: { removed: removed.count } };
}

/** Cancel the draft batch: none of its decisions take effect. Kept for the record. */
export async function cancelDraftBatch(ctx: AdmissionContext): Promise<DecisionResult> {
  const cancelled = await prisma.admissionDecisionBatch.updateMany({ where: { eventId: ctx.eventId, status: AdmissionBatchStatus.DRAFT, event: { organisationId: ctx.organisationId } }, data: { status: AdmissionBatchStatus.CANCELLED, cancelledAt: new Date() } });
  if (cancelled.count === 0) return fail("There are no drafted decisions.");
  await recordAuditEvent({ action: "ADMISSION_DECISIONS_CANCELLED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId });
  return { ok: true, data: undefined };
}

type Counts = Record<AdmissionDecisionOutcome, number>;

/** Release the draft batch: all its decisions take effect together, or none does. */
export async function releaseDraftBatch(ctx: AdmissionContext, now = new Date()): Promise<DecisionResult<Counts>> {
  const webhooks: WebhookEmission[] = [];
  try {
    const result = await prisma.$transaction(async (tx): Promise<DecisionResult<Counts>> => {
      const event = await lockAdmissionEvent(tx, ctx.eventId, ctx.organisationId);
      if (!event?.admissionEnabled) return fail("Applications are off for this event.");
      const batch = await tx.admissionDecisionBatch.findFirst({ where: { eventId: event.id, status: AdmissionBatchStatus.DRAFT }, select: { id: true, decisions: { select: { applicationId: true, stageId: true, outcome: true, expectedVersion: true, overrideReason: true, sourceRank: true } } } });
      if (!batch || batch.decisions.length === 0) return fail("There are no drafted decisions to release.");
      const apps = new Map((await tx.admissionApplication.findMany({ where: { id: { in: batch.decisions.map((d) => d.applicationId) } }, select: applicationSelect })).map((app) => [app.id, app]));
      const hasNext = await nextStageIds(tx, event.id);
      const changed = batch.decisions.filter((d) => {
        const app = apps.get(d.applicationId);
        return !app || app.version !== d.expectedVersion || app.currentStageId !== d.stageId || !allowedOutcomes(app.status, Boolean(hasNext.get(d.stageId))).includes(d.outcome);
      });
      if (changed.length) return fail(`${changed.length} ${changed.length === 1 ? "application has" : "applications have"} changed since the decision was drafted. Draft ${changed.length === 1 ? "it" : "them"} again.`);

      // Review coverage, per stage.
      let short = 0;
      for (const stageId of new Set(batch.decisions.map((d) => d.stageId))) {
        const decisions = batch.decisions.filter((d) => d.stageId === stageId);
        const coverage = await stageCoverage(tx, ctx, stageId, decisions.map((d) => apps.get(d.applicationId)!));
        short += decisions.filter((d) => !coverageMet(coverage.counted.get(d.applicationId) ?? 0, coverage.target, d.overrideReason)).length;
      }
      if (short) return fail(`${short} ${short === 1 ? "decision is" : "decisions are"} short of the stage's reviews. Wait for the reviews, or give an override reason.`);

      const accepts = batch.decisions.filter((d) => d.outcome === "ACCEPT").length;
      const left = offersLeft(offerCeiling(event), await countOfferHolding(tx, event.id));
      if (left != null && accepts > left) return fail(`Only ${left} ${left === 1 ? "offer is" : "offers are"} left, and this batch makes ${accepts}. Waitlist some, or raise the offer capacity.`);

      const counts: Counts = { ADVANCE: 0, ACCEPT: 0, WAITLIST: 0, REJECT: 0 };
      for (const decision of batch.decisions) {
        const app: ApplicationRow = apps.get(decision.applicationId)!;
        const change = { tx, event, app, now };
        if (decision.outcome === "ADVANCE") webhooks.push(...(await advanceApplication(change, { actorUserId: ctx.userId, sourceRank: decision.sourceRank })));
        else if (decision.outcome === "ACCEPT") webhooks.push(...(await offerPlace(change)));
        else if (decision.outcome === "WAITLIST") webhooks.push(...(await waitlistApplication(change)));
        else webhooks.push(...(await rejectApplication(change)));
        counts[decision.outcome] += 1;
      }
      await tx.admissionDecisionBatch.update({ where: { id: batch.id }, data: { status: AdmissionBatchStatus.RELEASED, releasedAt: now, releasedByUserId: ctx.userId } });
      await recordAuditEvent({
        client: tx,
        action: "ADMISSION_DECISIONS_RELEASED",
        actorUserId: ctx.userId,
        organisationId: ctx.organisationId,
        targetType: "Event",
        targetId: event.id,
        metadata: { batchId: batch.id, ...counts, overrides: batch.decisions.filter((d) => d.overrideReason).length },
      });
      return { ok: true, data: counts };
    }, { timeout: 60_000, maxWait: 10_000 });
    if (result.ok) emitAll(webhooks);
    return result;
  } catch (error) {
    if (error instanceof AdmissionError) return fail(error.message);
    throw error;
  }
}
