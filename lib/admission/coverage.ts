import "server-only";

import { AdmissionStatus, RsvpStatus, type Prisma } from "@prisma/client";
import { pairKey } from "@/lib/assignmentPlanner";
import { eligibleReviewers, stagePool } from "./access";
import { countedReviewers } from "./rules";

/*
 * Conflicts of interest and review coverage (docs/ADMISSION.md "Reviewers").
 *
 * A reviewer never reviews an application they have a conflict with:
 * - their own application, or their team's (they are one of its people);
 * - any application, when they have applied to the event themselves;
 * - one they (or an organiser) declared a conflict with (AdmissionReviewConflict);
 * - on a fresh-eyes stage (`AdmissionStage.freshEyes`), one they reviewed in
 *   an earlier stage.
 *
 * A review counts towards its stage's target when it is on the current
 * answers, by someone in the stage's reviewer pool now, with no conflict.
 */

type AppRef = { id: string; rsvpId: string | null; teamId: string | null };

/** The account ids of each application's people. */
export async function applicantUsers(tx: Prisma.TransactionClient, apps: readonly AppRef[]): Promise<Map<string, Set<string>>> {
  const solo = apps.filter((app) => app.rsvpId).map((app) => app.rsvpId!);
  const teams = apps.filter((app) => app.teamId).map((app) => app.teamId!);
  const rows = await tx.rSVP.findMany({ where: { OR: [{ id: { in: solo } }, { teamId: { in: teams } }], userId: { not: null } }, select: { id: true, teamId: true, userId: true } });
  const byRsvp = new Map(apps.filter((app) => app.rsvpId).map((app) => [app.rsvpId!, app.id]));
  const byTeam = new Map(apps.filter((app) => app.teamId).map((app) => [app.teamId!, app.id]));
  const users = new Map<string, Set<string>>(apps.map((app) => [app.id, new Set<string>()]));
  for (const row of rows) {
    const appId = (row.teamId ? byTeam.get(row.teamId) : undefined) ?? byRsvp.get(row.id);
    if (appId && row.userId) users.get(appId)!.add(row.userId);
  }
  return users;
}

/**
 * `pairKey(reviewer, application)` for every conflicted pair among these
 * reviewers and applications, in the stage `stageId` (whose fresh-eyes rule
 * applies).
 */
export async function blockedPairs(tx: Prisma.TransactionClient, eventId: string, apps: readonly AppRef[], reviewerIds: readonly string[], stageId: string): Promise<Set<string>> {
  const blocked = new Set<string>();
  if (apps.length === 0 || reviewerIds.length === 0) return blocked;
  const reviewers = [...new Set(reviewerIds)];
  const [users, declared, applied, earlier] = await Promise.all([
    applicantUsers(tx, apps),
    tx.admissionReviewConflict.findMany({ where: { eventId, reviewerUserId: { in: reviewers }, applicationId: { in: apps.map((app) => app.id) } }, select: { reviewerUserId: true, applicationId: true } }),
    // Reviewers who applied to this event themselves (a live registration that isn't crew).
    tx.rSVP.findMany({ where: { eventId, userId: { in: reviewers }, isCrew: false, status: { not: RsvpStatus.REJECTED } }, select: { userId: true }, distinct: ["userId"] }),
    earlierReviews(tx, eventId, stageId, apps, reviewers),
  ]);
  const applicants = new Set(applied.map((row) => row.userId!));
  for (const app of apps) {
    const people = users.get(app.id)!;
    for (const reviewer of reviewers) if (applicants.has(reviewer) || people.has(reviewer)) blocked.add(pairKey(reviewer, app.id));
  }
  for (const row of declared) blocked.add(pairKey(row.reviewerUserId, row.applicationId));
  for (const row of earlier) blocked.add(pairKey(row.reviewerUserId!, row.applicationId));
  return blocked;
}

/** Fresh eyes: reviews these reviewers gave these applications in a stage before `stageId`, when that stage asks for fresh eyes. */
async function earlierReviews(tx: Prisma.TransactionClient, eventId: string, stageId: string, apps: readonly AppRef[], reviewers: readonly string[]) {
  const stage = await tx.admissionStage.findFirst({ where: { id: stageId, eventId }, select: { freshEyes: true, position: true } });
  if (!stage?.freshEyes) return [];
  return tx.admissionReview.findMany({
    where: { applicationId: { in: apps.map((app) => app.id) }, reviewerUserId: { in: [...reviewers] }, stage: { eventId, position: { lt: stage.position } } },
    select: { reviewerUserId: true, applicationId: true },
    distinct: ["reviewerUserId", "applicationId"],
  });
}

export type StageCoverage = { stageId: string; target: number; pool: Set<string>; blocked: Set<string>; counted: Map<string, number> };

/** Counted reviews for these applications in one stage, with the stage's pool and target. */
export async function stageCoverage(tx: Prisma.TransactionClient, ctx: { organisationId: string; eventId: string }, stageId: string, apps: ReadonlyArray<AppRef & { answersRevision: number }>): Promise<StageCoverage> {
  const stage = await tx.admissionStage.findUniqueOrThrow({ where: { id: stageId }, select: { reviewsPerApplication: true, panel: { select: { userId: true } } } });
  const eligible = await eligibleReviewers(tx, ctx.organisationId, ctx.eventId);
  const pool = stagePool(stage.panel.map((row) => row.userId), eligible);
  // A review whose reviewer's account is gone no longer counts.
  const reviews = (await tx.admissionReview.findMany({ where: { stageId, applicationId: { in: apps.map((app) => app.id) }, reviewerUserId: { not: null } }, select: { applicationId: true, reviewerUserId: true, answersRevision: true } }))
    .map((review) => ({ ...review, reviewerUserId: review.reviewerUserId! }));
  const blocked = await blockedPairs(tx, ctx.eventId, apps, [...new Set(reviews.map((review) => review.reviewerUserId))], stageId);
  const counted = new Map<string, number>();
  for (const app of apps) {
    const mine = reviews.filter((review) => review.applicationId === app.id);
    counted.set(app.id, countedReviewers(mine, app.answersRevision, (id) => pool.has(id), (id) => blocked.has(pairKey(id, app.id))));
  }
  return { stageId, target: stage.reviewsPerApplication, pool, blocked, counted };
}

/** Applications still open to review in a stage (its current applications in review). */
export const inReviewAt = (eventId: string, stageId: string) => ({ eventId, currentStageId: stageId, status: AdmissionStatus.IN_REVIEW }) satisfies Prisma.AdmissionApplicationWhereInput;
