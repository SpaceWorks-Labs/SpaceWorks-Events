import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { AdmissionAssignmentStatus, JudgeAssignmentStrategy, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { pairKey, planAssignments, type AssignmentMode, type PlannerShortfall } from "@/lib/assignmentPlanner";
import { eligibleReviewers, stagePool, type AdmissionContext } from "./access";
import { blockedPairs, inReviewAt } from "./coverage";

/*
 * Assigning reviewers to a stage (docs/ADMISSION.md "Reviewers"), built the
 * way judging rounds assign judges (lib/assignmentPlanner.ts is shared):
 * BALANCED or RANDOM, reproducible from the stored seed; preview writes
 * nothing; apply re-plans under the Event lock with the same seed and is
 * refused when the plan changed since the preview; re-roll is a preview
 * without a seed. Conflicts and recusals are never assigned. "keep" adds to
 * the assignments there are; "replace" removes those not yet reviewed.
 * Applied runs are stored (AdmissionAssignmentRun) and audited.
 */

export type AssignInput = { stageId: string; perApplication: number; mode: AssignmentMode; strategy: "balanced" | "random"; reviewerIds: string[]; seed?: string; fingerprint?: string };

export type AssignPreview = {
  applications: number;
  covered: number;
  added: number;
  removed: number;
  loads: Array<{ reviewerId: string; before: number; added: number; removed: number; after: number }>;
  shortfalls: PlannerShortfall[];
  fingerprint: string;
  seed: string | null;
  strategy: "balanced" | "random";
};

type Result<T> = { ok: true; data: T } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });
const POOL_CHANGED = "Some of the people you picked can't review this stage any more. Refresh and try again.";
const PLAN_CHANGED = "Applications, reviewers or assignments changed since the preview. Preview again before applying.";

export function newAdmissionSeed(): string {
  return randomBytes(16).toString("hex");
}

async function buildPlan(tx: Prisma.TransactionClient, ctx: AdmissionContext, input: AssignInput, seed: string | null) {
  const stage = await tx.admissionStage.findFirst({ where: { id: input.stageId, eventId: ctx.eventId, event: { organisationId: ctx.organisationId } }, select: { id: true, panel: { select: { userId: true } } } });
  if (!stage) return fail("Stage not found.");
  const pool = stagePool(stage.panel.map((row) => row.userId), await eligibleReviewers(tx, ctx.organisationId, ctx.eventId));
  const picked = [...new Set(input.reviewerIds)].sort();
  if (picked.length === 0 || picked.some((id) => !pool.has(id))) return fail(POOL_CHANGED);
  const apps = await tx.admissionApplication.findMany({ where: inReviewAt(ctx.eventId, stage.id), select: { id: true, rsvpId: true, teamId: true }, orderBy: { id: "asc" } });
  const assignments = await tx.admissionReviewAssignment.findMany({ where: { stageId: stage.id, applicationId: { in: apps.map((app) => app.id) } }, select: { id: true, applicationId: true, reviewerUserId: true, status: true } });
  const live = assignments.filter((row) => row.status !== AdmissionAssignmentStatus.RECUSED);
  const blocked = await blockedPairs(tx, ctx.eventId, apps, [...new Set([...picked, ...live.map((row) => row.reviewerUserId)])]);
  for (const row of assignments) if (row.status === AdmissionAssignmentStatus.RECUSED) blocked.add(pairKey(row.reviewerUserId, row.applicationId));
  const started = new Set(live.filter((row) => row.status === AdmissionAssignmentStatus.SUBMITTED).map((row) => pairKey(row.reviewerUserId, row.applicationId)));
  const plan = planAssignments({
    itemIds: apps.map((app) => app.id),
    poolReviewerIds: picked,
    perItem: input.perApplication,
    mode: input.mode,
    existing: live.map((row) => ({ reviewerId: row.reviewerUserId, itemId: row.applicationId })),
    blocked,
    started,
    canReview: (id) => pool.has(id),
    seed,
  });
  const inputHash = createHash("sha256");
  inputHash.update(`${input.strategy}:${input.mode}:${input.perApplication}:${seed ?? "-"}\n`);
  for (const app of apps) inputHash.update(`a:${app.id}\n`);
  for (const id of picked) inputHash.update(`r:${id}\n`);
  for (const key of live.map((row) => `${row.reviewerUserId}:${row.applicationId}`).sort()) inputHash.update(`x:${key}\n`);
  for (const key of [...blocked].sort()) inputHash.update(`b:${key.replace("\u0000", ":")}\n`);
  const ids = new Map(live.map((row) => [pairKey(row.reviewerUserId, row.applicationId), row.id]));
  return { ok: true as const, data: { stage, plan, apps: apps.length, ids, inputFingerprint: inputHash.digest("base64url").slice(0, 22) } };
}

export async function previewAssignment(ctx: AdmissionContext, input: AssignInput): Promise<Result<AssignPreview>> {
  // A RANDOM preview without a seed draws a new one ("Re-roll").
  const seed = input.strategy === "random" ? input.seed ?? newAdmissionSeed() : null;
  const built = await buildPlan(prisma, ctx, input, seed);
  if (!built.ok) return built;
  const { plan } = built.data;
  return {
    ok: true,
    data: { applications: built.data.apps, covered: plan.covered, added: plan.add.length, removed: plan.remove.length, loads: plan.loads, shortfalls: plan.shortfalls.slice(0, 50), fingerprint: plan.fingerprint, seed, strategy: input.strategy },
  };
}

export async function applyAssignment(ctx: AdmissionContext, input: AssignInput): Promise<Result<{ added: number; removed: number; runId: string; seed: string | null }>> {
  if (!input.fingerprint || (input.strategy === "random" && !input.seed)) return fail(PLAN_CHANGED);
  const seed = input.strategy === "random" ? input.seed! : null;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${ctx.eventId} FOR UPDATE`;
    const built = await buildPlan(tx, ctx, input, seed);
    if (!built.ok) return built;
    const { plan, stage } = built.data;
    if (plan.fingerprint !== input.fingerprint) return fail(PLAN_CHANGED);
    const run = await tx.admissionAssignmentRun.create({
      data: {
        stageId: stage.id,
        strategy: input.strategy === "random" ? JudgeAssignmentStrategy.RANDOM : JudgeAssignmentStrategy.BALANCED,
        mode: input.mode,
        seed,
        perApplication: input.perApplication,
        reviewers: plan.loads.length,
        added: plan.add.length,
        removed: plan.remove.length,
        inputFingerprint: built.data.inputFingerprint,
        planFingerprint: plan.fingerprint,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    const removeIds = plan.remove.map((pair) => built.data.ids.get(pairKey(pair.reviewerId, pair.itemId))).filter((id): id is string => Boolean(id));
    if (removeIds.length) await tx.admissionReviewAssignment.deleteMany({ where: { id: { in: removeIds }, status: AdmissionAssignmentStatus.ASSIGNED } });
    if (plan.add.length) await tx.admissionReviewAssignment.createMany({ data: plan.add.map((pair) => ({ stageId: stage.id, applicationId: pair.itemId, reviewerUserId: pair.reviewerId, runId: run.id })), skipDuplicates: true });
    await tx.admissionStage.update({ where: { id: stage.id }, data: { reviewsPerApplication: input.perApplication } });
    await recordAuditEvent({
      client: tx,
      action: "ADMISSION_REVIEWERS_ASSIGNED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: ctx.eventId,
      metadata: { stageId: stage.id, run: run.id, strategy: input.strategy, mode: input.mode, perApplication: input.perApplication, added: plan.add.length, removed: removeIds.length, shortfalls: plan.shortfalls.length, ...(seed ? { seed } : {}) },
    });
    return { ok: true as const, data: { added: plan.add.length, removed: removeIds.length, runId: run.id, seed } };
  }, { timeout: 30_000, maxWait: 10_000 });
}

/** Assign one reviewer by hand (conflicts and recusals refused). */
export async function assignReviewer(ctx: AdmissionContext, params: { stageId: string; applicationId: string; reviewerUserId: string }): Promise<Result<undefined>> {
  return prisma.$transaction(async (tx) => {
    const stage = await tx.admissionStage.findFirst({ where: { id: params.stageId, eventId: ctx.eventId, event: { organisationId: ctx.organisationId } }, select: { id: true, panel: { select: { userId: true } } } });
    const app = await tx.admissionApplication.findFirst({ where: { id: params.applicationId, ...inReviewAt(ctx.eventId, params.stageId) }, select: { id: true, rsvpId: true, teamId: true } });
    if (!stage || !app) return fail("That application isn't in review in this stage.");
    const pool = stagePool(stage.panel.map((row) => row.userId), await eligibleReviewers(tx, ctx.organisationId, ctx.eventId));
    if (!pool.has(params.reviewerUserId)) return fail("That person isn't on this stage's reviewer panel.");
    if ((await blockedPairs(tx, ctx.eventId, [app], [params.reviewerUserId])).size) return fail("That reviewer has a conflict with this application.");
    const existing = await tx.admissionReviewAssignment.findUnique({ where: { stageId_applicationId_reviewerUserId: { stageId: stage.id, applicationId: app.id, reviewerUserId: params.reviewerUserId } }, select: { status: true } });
    if (existing?.status === AdmissionAssignmentStatus.RECUSED) return fail("That reviewer stepped back from this application.");
    if (!existing) await tx.admissionReviewAssignment.create({ data: { stageId: stage.id, applicationId: app.id, reviewerUserId: params.reviewerUserId } });
    await recordAuditEvent({ client: tx, action: "ADMISSION_REVIEWER_ASSIGNED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId, metadata: { stageId: stage.id, applicationId: app.id, reviewerUserId: params.reviewerUserId } });
    return { ok: true as const, data: undefined };
  });
}

/** Remove an assignment not yet reviewed. */
export async function unassignReviewer(ctx: AdmissionContext, assignmentId: string): Promise<Result<undefined>> {
  const removed = await prisma.admissionReviewAssignment.deleteMany({ where: { id: assignmentId, status: AdmissionAssignmentStatus.ASSIGNED, stage: { eventId: ctx.eventId, event: { organisationId: ctx.organisationId } } } });
  if (removed.count !== 1) return fail("Only an assignment that hasn't been reviewed can be removed.");
  await recordAuditEvent({ action: "ADMISSION_REVIEWER_UNASSIGNED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId, metadata: { assignmentId } });
  return { ok: true, data: undefined };
}
