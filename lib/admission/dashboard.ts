import "server-only";

import { AdmissionBatchStatus, AdmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { eligibleReviewers, stagePool, type AdmissionContext } from "./access";
import { applicationPeople } from "./answers";
import { stageCoverage } from "./coverage";
import { offerCeiling, reviewMean } from "./rules";
import { countOfferHolding, isPaid, unitOrder } from "./state";

/*
 * The organiser's Applications tab (docs/ADMISSION.md): settings, stages and
 * panels, the applications with their review coverage and drafted decision,
 * and the offers and waitlist. Ids, names and counts only; answers and
 * reviews load per application (applicationDetail).
 */

const LIST_LIMIT = 500;

export async function loadAdmissionDashboard(ctx: AdmissionContext) {
  const event = await prisma.event.findFirst({
    where: { id: ctx.eventId, organisationId: ctx.organisationId },
    select: { id: true, title: true, timezone: true, startDateTime: true, capacity: true, registrationMode: true, submissionsEnabled: true, admissionEnabled: true, admissionMode: true, admissionRsvpDays: true, admissionOfferCapacity: true, emailApplicantsOnStageAdvance: true },
  });
  if (!event) return null;
  const [stages, eligible, apps, draft, holding] = await Promise.all([
    prisma.admissionStage.findMany({ where: { eventId: event.id }, orderBy: { position: "asc" }, select: { id: true, position: true, name: true, status: true, reviewsPerApplication: true, blindReview: true, criteria: true, guidance: true, opensAt: true, closesAt: true, panel: { select: { userId: true } }, _count: { select: { entries: true } } } }),
    eligibleReviewers(prisma, ctx.organisationId, event.id),
    prisma.admissionApplication.findMany({
      where: { eventId: event.id },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      take: LIST_LIMIT,
      select: {
        id: true, rsvpId: true, teamId: true, subjectName: true, status: true, currentStageId: true, answersRevision: true, respondBy: true, queuedAt: true, skipReason: true, submittedAt: true, version: true,
        team: { select: { name: true, _count: { select: { members: true } } } },
        rsvp: { select: { guestName: true, guestEmail: true, user: { select: { name: true, email: true } } } },
        reviews: { select: { stageId: true, scores: true, answersRevision: true } },
        assignments: { select: { id: true, stageId: true, reviewerUserId: true, status: true } },
      },
    }),
    prisma.admissionDecisionBatch.findFirst({ where: { eventId: event.id, status: AdmissionBatchStatus.DRAFT }, select: { id: true, decisions: { select: { applicationId: true, outcome: true, overrideReason: true, note: true, expectedVersion: true } } } }),
    countOfferHolding(prisma, event.id),
  ]);
  const reviewerIds = [...new Set([...eligible.grantees, ...eligible.admins])];
  const users = await prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, name: true, email: true } });
  const reviewerName = new Map(users.map((user) => [user.id, user.name?.trim() || user.email || "Reviewer"]));

  const counted = new Map<string, number>();
  for (const stage of stages) {
    const here = apps.filter((app) => app.currentStageId === stage.id && app.status === AdmissionStatus.IN_REVIEW);
    if (here.length === 0) continue;
    const coverage = await stageCoverage(prisma, ctx, stage.id, here);
    for (const [id, value] of coverage.counted) counted.set(id, value);
  }
  const decisionOf = new Map((draft?.decisions ?? []).map((decision) => [decision.applicationId, decision]));
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));

  return {
    settings: {
      enabled: event.admissionEnabled,
      mode: event.admissionMode,
      rsvpDays: event.admissionRsvpDays,
      offerCapacity: event.admissionOfferCapacity,
      emailOnStageAdvance: event.emailApplicantsOnStageAdvance,
      capacity: event.capacity,
      ceiling: offerCeiling(event),
      holding,
      team: event.registrationMode === "TEAM",
      hackathon: event.submissionsEnabled,
      timezone: event.timezone,
      startsAt: event.startDateTime.toISOString(),
    },
    reviewers: reviewerIds.map((id) => ({ userId: id, name: reviewerName.get(id) ?? "Reviewer", grantee: eligible.grantees.has(id), admin: eligible.admins.has(id) })).sort((a, b) => a.name.localeCompare(b.name)),
    stages: stages.map((stage) => ({
      id: stage.id,
      position: stage.position,
      name: stage.name,
      status: stage.status,
      reviewsPerApplication: stage.reviewsPerApplication,
      blindReview: stage.blindReview,
      criteria: stage.criteria,
      guidance: stage.guidance,
      panelUserIds: stage.panel.map((row) => row.userId),
      poolSize: stagePool(stage.panel.map((row) => row.userId), eligible).size,
      entries: stage._count.entries,
      inReview: apps.filter((app) => app.currentStageId === stage.id && app.status === AdmissionStatus.IN_REVIEW).length,
    })),
    applications: apps.map((app) => {
      const stage = app.currentStageId ? stageById.get(app.currentStageId) : undefined;
      const here = app.reviews.filter((review) => review.stageId === app.currentStageId && review.answersRevision === app.answersRevision);
      const means = here.map((review) => reviewMean(review.scores as Record<string, number>));
      const decision = decisionOf.get(app.id);
      return {
        id: app.id,
        name: app.team?.name ?? (app.rsvp?.user?.name?.trim() || app.rsvp?.guestName?.trim() || app.subjectName || "Guest"),
        email: app.rsvp ? app.rsvp.user?.email ?? app.rsvp.guestEmail : null,
        teamSize: app.team?._count.members ?? null,
        status: app.status,
        stageId: app.currentStageId,
        stageName: stage?.name ?? null,
        counted: counted.get(app.id) ?? 0,
        target: stage?.reviewsPerApplication ?? 1,
        mean: means.length ? Math.round((means.reduce((sum, value) => sum + value, 0) / means.length) * 10) / 10 : null,
        assigned: app.assignments.filter((row) => row.stageId === app.currentStageId && row.status !== "RECUSED").map((row) => ({ id: row.id, reviewer: reviewerName.get(row.reviewerUserId) ?? "Reviewer", reviewed: row.status === "SUBMITTED" })),
        respondBy: app.respondBy?.toISOString() ?? null,
        queuedAt: app.queuedAt?.toISOString() ?? null,
        skipReason: app.skipReason,
        submittedAt: app.submittedAt.toISOString(),
        draft: decision ? { outcome: decision.outcome, overrideReason: decision.overrideReason, note: decision.note, stale: decision.expectedVersion !== app.version } : null,
      };
    }),
    draftCount: draft?.decisions.length ?? 0,
    truncated: apps.length === LIST_LIMIT,
  };
}

export type AdmissionDashboard = NonNullable<Awaited<ReturnType<typeof loadAdmissionDashboard>>>;

/** One application's people, answers and reviews, for the organiser (never blind). */
export async function applicationDetail(ctx: AdmissionContext, applicationId: string) {
  const app = await prisma.admissionApplication.findFirst({
    where: { id: applicationId, eventId: ctx.eventId, event: { organisationId: ctx.organisationId } },
    select: { id: true, rsvpId: true, teamId: true, answersRevision: true, reviews: { orderBy: { createdAt: "asc" }, select: { scores: true, notes: true, answersRevision: true, createdAt: true, stage: { select: { name: true } }, reviewer: { select: { name: true, email: true } } } }, answerRevisions: { select: { id: true } } },
  });
  if (!app) return null;
  const shown = await applicationPeople(prisma, app, false);
  return {
    ...shown,
    paid: isPaid(await unitOrder(prisma, app)),
    answerRevisions: app.answerRevisions.length,
    reviews: app.reviews.map((review) => ({
      stage: review.stage.name,
      reviewer: review.reviewer ? review.reviewer.name?.trim() || review.reviewer.email || "Reviewer" : "Former reviewer",
      scores: review.scores as Record<string, number>,
      mean: reviewMean(review.scores as Record<string, number>),
      notes: review.notes,
      current: review.answersRevision === app.answersRevision,
      at: review.createdAt.toISOString(),
    })),
  };
}
