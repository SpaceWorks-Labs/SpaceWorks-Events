import "server-only";

import { AdmissionStageStatus, AdmissionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { eligibleReviewers } from "./access";
import type { AdmissionContext } from "./access";
import { ADMISSION_STAGES_LIMIT } from "./rules";

/*
 * Stages (docs/ADMISSION.md "Stages"). Every application enters stage 1;
 * later stages hold only the applications advanced into them. A stage has
 * its own reviewer panel (none: every REVIEW_APPLICATIONS collaborator), its
 * review target, blind review and criteria. Reviewers review only while a
 * stage is OPEN. Stages are added at the end; only the last stage, with
 * nobody in it, can be deleted, and stage 1 always stays.
 */

export type StageInput = {
  name: string;
  reviewsPerApplication: number;
  blindReview: boolean;
  criteria: string[];
  guidance: string;
  opensAt: Date | null;
  closesAt: Date | null;
};

type Result<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });

export async function createStage(ctx: AdmissionContext, input: StageInput): Promise<Result<{ id: string }>> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${ctx.eventId} FOR UPDATE`;
    const event = await tx.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId, admissionEnabled: true }, select: { id: true } });
    if (!event) return fail("Turn applications on first.");
    const last = await tx.admissionStage.findFirst({ where: { eventId: event.id }, orderBy: { position: "desc" }, select: { position: true } });
    if ((last?.position ?? 0) >= ADMISSION_STAGES_LIMIT) return fail(`An event can have up to ${ADMISSION_STAGES_LIMIT} stages.`);
    const stage = await tx.admissionStage.create({ data: { eventId: event.id, position: (last?.position ?? 0) + 1, ...input }, select: { id: true } });
    await recordAuditEvent({ client: tx, action: "ADMISSION_STAGE_CREATED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: event.id, metadata: { stageId: stage.id } });
    return { ok: true as const, data: stage };
  });
}

export async function updateStage(ctx: AdmissionContext, stageId: string, input: StageInput & { status: AdmissionStageStatus }): Promise<Result> {
  const updated = await prisma.admissionStage.updateMany({ where: { id: stageId, eventId: ctx.eventId, event: { organisationId: ctx.organisationId } }, data: input });
  if (updated.count !== 1) return fail("Stage not found.");
  await recordAuditEvent({ action: "ADMISSION_STAGE_UPDATED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId, metadata: { stageId, status: input.status } });
  return { ok: true, data: undefined };
}

export async function deleteStage(ctx: AdmissionContext, stageId: string): Promise<Result> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${ctx.eventId} FOR UPDATE`;
    const stage = await tx.admissionStage.findFirst({ where: { id: stageId, eventId: ctx.eventId, event: { organisationId: ctx.organisationId } }, select: { id: true, position: true, _count: { select: { entries: true, decisions: true } } } });
    if (!stage) return fail("Stage not found.");
    if (stage.position === 1) return fail("The first stage can't be deleted.");
    const last = await tx.admissionStage.findFirst({ where: { eventId: ctx.eventId }, orderBy: { position: "desc" }, select: { id: true } });
    if (last?.id !== stage.id) return fail("Only the last stage can be deleted.");
    if (stage._count.entries > 0 || stage._count.decisions > 0) return fail("Applications have reached this stage, so it can't be deleted.");
    await tx.admissionStage.delete({ where: { id: stage.id } });
    await recordAuditEvent({ client: tx, action: "ADMISSION_STAGE_DELETED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId, metadata: { stageId } });
    return { ok: true as const, data: undefined };
  });
}

/** Set a stage's reviewer panel; an empty list means every REVIEW_APPLICATIONS collaborator. */
export async function setStagePanel(ctx: AdmissionContext, stageId: string, userIds: string[]): Promise<Result<{ panel: number }>> {
  const ids = [...new Set(userIds)];
  return prisma.$transaction(async (tx) => {
    const stage = await tx.admissionStage.findFirst({ where: { id: stageId, eventId: ctx.eventId, event: { organisationId: ctx.organisationId } }, select: { id: true } });
    if (!stage) return fail("Stage not found.");
    const eligible = await eligibleReviewers(tx, ctx.organisationId, ctx.eventId);
    if (ids.some((id) => !eligible.grantees.has(id) && !eligible.admins.has(id))) return fail("Some of the people you picked can't review this event's applications. Give them the Review applications permission first.");
    await tx.admissionStageReviewer.deleteMany({ where: { stageId, userId: { notIn: ids } } });
    if (ids.length) await tx.admissionStageReviewer.createMany({ data: ids.map((userId) => ({ stageId, userId })), skipDuplicates: true });
    await recordAuditEvent({ client: tx, action: "ADMISSION_PANEL_SET", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId, metadata: { stageId, reviewers: ids.length } });
    return { ok: true as const, data: { panel: ids.length } };
  });
}

/**
 * Whether a registration's (or team's) application reached a stage and is
 * still standing (not withdrawn, declined, expired or rejected). A team
 * member's registration answers for its team's application. For other
 * features, such as per-stage reimbursements, that key off "reached stage N".
 */
export async function applicationReachedStage(
  client: Prisma.TransactionClient,
  params: { eventId: string; stageId: string } & ({ rsvpId: string } | { teamId: string }),
): Promise<boolean> {
  let where: Prisma.AdmissionApplicationWhereInput;
  if ("teamId" in params) where = { teamId: params.teamId };
  else {
    const rsvp = await client.rSVP.findUnique({ where: { id: params.rsvpId }, select: { eventId: true, teamId: true } });
    if (!rsvp || rsvp.eventId !== params.eventId) return false;
    where = rsvp.teamId ? { teamId: rsvp.teamId } : { rsvpId: params.rsvpId };
  }
  const entry = await client.admissionStageEntry.findFirst({
    where: {
      stageId: params.stageId,
      stage: { eventId: params.eventId },
      application: { ...where, eventId: params.eventId, status: { in: [AdmissionStatus.IN_REVIEW, AdmissionStatus.OFFERED, AdmissionStatus.WAITLISTED, AdmissionStatus.ACCEPTED] } },
    },
    select: { id: true },
  });
  return Boolean(entry);
}
