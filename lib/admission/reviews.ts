import "server-only";

import { AdmissionAssignmentStatus, AdmissionStageStatus, AdmissionStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { pairKey, tieHash } from "@/lib/assignmentPlanner";
import { eligibleReviewers, stagePool, type AdmissionContext } from "./access";
import { applicationPeople, type ApplicantPerson } from "./answers";
import { blockedPairs } from "./coverage";
import { normaliseScores, OVERALL_CRITERION } from "./rules";

/*
 * The reviewer workspace (docs/ADMISSION.md "Reviewing"). A reviewer sees
 * only the applications assigned to them, as their stage allows (a blind
 * stage hides who applied), and reviews only while the stage is OPEN, the
 * application is in review at that stage, they are still on its panel and
 * have no conflict. Reviews are append-only; a reviewer who steps back
 * (recuses) records a conflict and the application is offered to the
 * least-loaded reviewer left on the panel.
 */

type Result<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });
const NOT_YOURS = "This review isn't assigned to you.";

export type ReviewQueueItem = { assignmentId: string; stageName: string; stagePosition: number; stageOpen: boolean; label: string; status: AdmissionAssignmentStatus; reviewedCurrent: boolean };

/** The reviewer's assignments on this event, open stages first. */
export async function listMyReviews(ctx: AdmissionContext): Promise<ReviewQueueItem[]> {
  const rows = await prisma.admissionReviewAssignment.findMany({
    where: { reviewerUserId: ctx.userId, status: { not: AdmissionAssignmentStatus.RECUSED }, stage: { eventId: ctx.eventId, event: { organisationId: ctx.organisationId } }, application: { status: AdmissionStatus.IN_REVIEW } },
    select: { id: true, status: true, applicationId: true, stage: { select: { name: true, position: true, status: true, blindReview: true } }, application: { select: { answersRevision: true, team: { select: { name: true } }, rsvp: { select: { guestName: true, user: { select: { name: true } } } } } }, reviews: { select: { answersRevision: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 500,
  });
  return rows
    .map((row, index) => ({
      assignmentId: row.id,
      stageName: row.stage.name,
      stagePosition: row.stage.position,
      stageOpen: row.stage.status === AdmissionStageStatus.OPEN,
      label: row.stage.blindReview ? `Application ${index + 1}` : row.application.team?.name ?? (row.application.rsvp?.user?.name?.trim() || row.application.rsvp?.guestName?.trim() || "Applicant"),
      status: row.status,
      reviewedCurrent: row.reviews.some((review) => review.answersRevision === row.application.answersRevision),
    }))
    .sort((a, b) => Number(b.stageOpen) - Number(a.stageOpen) || Number(a.reviewedCurrent) - Number(b.reviewedCurrent) || a.stagePosition - b.stagePosition);
}

async function ownAssignment(client: Prisma.TransactionClient, ctx: AdmissionContext, assignmentId: string) {
  return client.admissionReviewAssignment.findFirst({
    where: { id: assignmentId, reviewerUserId: ctx.userId, stage: { eventId: ctx.eventId, event: { organisationId: ctx.organisationId } } },
    select: { id: true, status: true, stageId: true, applicationId: true, stage: { select: { name: true, status: true, blindReview: true, criteria: true, guidance: true, panel: { select: { userId: true } } } }, application: { select: { id: true, rsvpId: true, teamId: true, status: true, currentStageId: true, answersRevision: true } } },
  });
}

export type ReviewItem = { assignmentId: string; stageName: string; stageOpen: boolean; blind: boolean; criteria: string[]; guidance: string; teamName: string | null; people: ApplicantPerson[]; reviewed: { scores: Record<string, number>; notes: string } | null; canReview: boolean };

export async function loadReviewItem(ctx: AdmissionContext, assignmentId: string): Promise<ReviewItem | null> {
  const assignment = await ownAssignment(prisma, ctx, assignmentId);
  if (!assignment || assignment.status === AdmissionAssignmentStatus.RECUSED) return null;
  const { stage, application } = assignment;
  // Off the panel now, or a conflict: no more reading either.
  const pool = stagePool(stage.panel.map((row) => row.userId), await eligibleReviewers(prisma, ctx.organisationId, ctx.eventId));
  if (!pool.has(ctx.userId) || (await blockedPairs(prisma, ctx.eventId, [application], [ctx.userId])).size) return null;
  const shown = await applicationPeople(prisma, application, stage.blindReview);
  const review = await prisma.admissionReview.findFirst({ where: { assignmentId, answersRevision: application.answersRevision }, select: { scores: true, notes: true } });
  const open = stage.status === AdmissionStageStatus.OPEN && application.status === AdmissionStatus.IN_REVIEW && application.currentStageId === assignment.stageId;
  return {
    assignmentId,
    stageName: stage.name,
    stageOpen: open,
    blind: stage.blindReview,
    criteria: stage.criteria.length ? stage.criteria : [OVERALL_CRITERION],
    guidance: stage.guidance,
    ...shown,
    reviewed: review ? { scores: review.scores as Record<string, number>, notes: review.notes } : null,
    canReview: open && !review,
  };
}

export async function submitReview(ctx: AdmissionContext, assignmentId: string, input: { scores: Record<string, unknown>; notes: string }): Promise<Result> {
  return prisma.$transaction(async (tx) => {
    const assignment = await ownAssignment(tx, ctx, assignmentId);
    if (!assignment || assignment.status === AdmissionAssignmentStatus.RECUSED) return fail(NOT_YOURS);
    const { stage, application } = assignment;
    if (stage.status !== AdmissionStageStatus.OPEN) return fail("This stage isn't open for reviews.");
    if (application.status !== AdmissionStatus.IN_REVIEW || application.currentStageId !== assignment.stageId) return fail("This application has moved on, so it can't be reviewed here any more.");
    const pool = stagePool(stage.panel.map((row) => row.userId), await eligibleReviewers(tx, ctx.organisationId, ctx.eventId));
    if (!pool.has(ctx.userId)) return fail("You aren't on this stage's reviewer panel any more.");
    if ((await blockedPairs(tx, ctx.eventId, [application], [ctx.userId])).size) return fail("You have a conflict with this application, so you can't review it.");
    const scores = normaliseScores(stage.criteria, input.scores);
    if (!scores) return fail("Score every criterion from 1 to 5.");
    try {
      await tx.admissionReview.create({ data: { assignmentId, stageId: assignment.stageId, applicationId: application.id, reviewerUserId: ctx.userId, answersRevision: application.answersRevision, scores, notes: input.notes.trim() } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return fail("You have already reviewed these answers.");
      throw error;
    }
    await tx.admissionReviewAssignment.update({ where: { id: assignmentId }, data: { status: AdmissionAssignmentStatus.SUBMITTED } });
    await recordAuditEvent({ client: tx, action: "ADMISSION_REVIEW_SUBMITTED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId, metadata: { assignmentId } });
    return { ok: true as const, data: undefined };
  });
}

/** Step back from an application (a conflict of interest): recorded, and someone else on the panel takes it. */
export async function recuse(ctx: AdmissionContext, assignmentId: string): Promise<Result<{ replacedBy: boolean }>> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${ctx.eventId} FOR UPDATE`;
    const assignment = await ownAssignment(tx, ctx, assignmentId);
    if (!assignment) return fail(NOT_YOURS);
    if (assignment.status !== AdmissionAssignmentStatus.ASSIGNED) return fail("You can step back only from an application you haven't reviewed.");
    await tx.admissionReviewAssignment.update({ where: { id: assignmentId }, data: { status: AdmissionAssignmentStatus.RECUSED } });
    await tx.admissionReviewConflict.upsert({
      where: { reviewerUserId_applicationId: { reviewerUserId: ctx.userId, applicationId: assignment.applicationId } },
      create: { eventId: ctx.eventId, reviewerUserId: ctx.userId, applicationId: assignment.applicationId, reason: "declared" },
      update: {},
    });
    const replacement = await pickReplacement(tx, ctx, assignment.stageId, assignment.application, assignment.stage.panel.map((row) => row.userId));
    if (replacement) await tx.admissionReviewAssignment.create({ data: { stageId: assignment.stageId, applicationId: assignment.applicationId, reviewerUserId: replacement } });
    await recordAuditEvent({ client: tx, action: "ADMISSION_REVIEWER_RECUSED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId, metadata: { assignmentId, replaced: Boolean(replacement) } });
    return { ok: true as const, data: { replacedBy: Boolean(replacement) } };
  });
}

/** The panel reviewer with the fewest live assignments in the stage, not yet on this application and without a conflict. */
async function pickReplacement(tx: Prisma.TransactionClient, ctx: AdmissionContext, stageId: string, app: { id: string; rsvpId: string | null; teamId: string | null }, panel: string[]): Promise<string | null> {
  const pool = stagePool(panel, await eligibleReviewers(tx, ctx.organisationId, ctx.eventId));
  const taken = new Set((await tx.admissionReviewAssignment.findMany({ where: { stageId, applicationId: app.id }, select: { reviewerUserId: true } })).map((row) => row.reviewerUserId));
  const candidates = [...pool].filter((id) => !taken.has(id));
  if (candidates.length === 0) return null;
  const blocked = await blockedPairs(tx, ctx.eventId, [app], candidates);
  const loads = await tx.admissionReviewAssignment.groupBy({ by: ["reviewerUserId"], where: { stageId, reviewerUserId: { in: candidates }, status: { not: AdmissionAssignmentStatus.RECUSED } }, _count: { _all: true } });
  const load = new Map(loads.map((row) => [row.reviewerUserId, row._count._all]));
  const ranked = candidates
    .filter((id) => !blocked.has(pairKey(id, app.id)))
    .map((id) => ({ id, load: load.get(id) ?? 0, tie: tieHash(pairKey(id, app.id)) }))
    .sort((a, b) => a.load - b.load || a.tie - b.tie || (a.id < b.id ? -1 : 1));
  return ranked[0]?.id ?? null;
}
