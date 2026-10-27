import { randomUUID } from "node:crypto";
import { EventPermission, EventStatus, JudgingStatus, MembershipRole, RegistrationMode, SubmissionStatus, type Event } from "@prisma/client";
import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { resolveJudgeContext, resolveJudgingOrganiser, type JudgeContext, type JudgingOrganiserContext } from "@/lib/judgingAccess";
import { createJudgingCriterion, saveJudgeScores, setJudgingStatus, submitJudgeReview } from "@/lib/core/judging";
import { createJudgingRound, finalizeJudgingRound, setJudgingRoundStatus } from "@/lib/core/judgingRounds";
import { setReviewsPerProject } from "@/lib/core/judgingOps";

/*
 * Shared setup for the judging rounds suites (docs/HACKATHON.md "Rounds"):
 * judging-rounds{,-advance,-assign,-migration}.db.test.ts. Each test file
 * mocks `@/lib/auth` itself and calls setUpRounds / tearDownRounds.
 */

export const suffix = randomUUID().replaceAll("-", "");
export const orgSlug = `rounds-${suffix}`;
export const otherOrgSlug = `rounds-other-${suffix}`;
const startedAt = new Date();
export const HOUR = 3_600_000;
export let organisationId = "";
export let otherOrganisationId = "";
export const users: Record<"owner" | "j1" | "j2" | "j3" | "j4" | "entrant" | "outsider", string> = { owner: "", j1: "", j2: "", j3: "", j4: "", entrant: "", outsider: "" };
let sequence = 0;

export async function createEvent(orgId = organisationId): Promise<Event> {
  return prisma.event.create({
    data: {
      organisationId: orgId,
      title: `Rounds ${suffix}`,
      slug: `rounds-${suffix}-${randomUUID().slice(0, 8)}`,
      startDateTime: new Date(Date.now() + 24 * HOUR),
      endDateTime: new Date(Date.now() + 48 * HOUR),
      timezone: "UTC",
      status: EventStatus.PUBLISHED,
      registrationMode: RegistrationMode.INDIVIDUAL,
      submissionsEnabled: true,
      submissionsOpenAt: new Date(Date.now() - HOUR),
      submissionsCloseAt: new Date(Date.now() + HOUR),
      page: { create: { isPublished: true } },
    },
  });
}

/** A SUBMITTED solo project (the registrant's account when `userId`, else a guest with an email). */
export async function project(event: Event, title: string, userId: string | null = null, status: SubmissionStatus = SubmissionStatus.SUBMITTED) {
  sequence += 1;
  const slug = event.organisationId === otherOrganisationId ? otherOrgSlug : orgSlug;
  const result = await submitRsvpCore(
    { orgSlug: slug, eventSlug: event.slug, ...(userId ? {} : { guestEmail: `entrant-${sequence}-${suffix}@example.test` }), name: `Entrant ${sequence}`, answers: {} },
    { userId },
  );
  if (!result.ok || !result.data) throw new Error(`registration failed: ${result.ok ? "no data" : result.error}`);
  const rsvp = await prisma.rSVP.findUniqueOrThrow({ where: { checkInToken: result.data.ticketToken } });
  return prisma.submission.create({ data: { eventId: event.id, rsvpId: rsvp.id, title, status, submittedAt: new Date(Date.now() - 1000 * (100 - sequence)) } });
}

export async function grantJudges(event: Event, ...ids: string[]) {
  for (const userId of ids) await prisma.eventCollaborator.create({ data: { eventId: event.id, userId, permissions: [EventPermission.JUDGE] } });
}

export async function organiser(event: Event, userId = users.owner): Promise<JudgingOrganiserContext> {
  const ctx = await resolveJudgingOrganiser(userId, event.organisationId === otherOrganisationId ? otherOrgSlug : orgSlug, event.id);
  if (!ctx) throw new Error("organiser context missing");
  return ctx;
}

export async function judge(event: Event, userId: string): Promise<JudgeContext> {
  const ctx = await resolveJudgeContext(userId, orgSlug, event.id);
  if (!ctx) throw new Error("judge context missing");
  return ctx;
}

export function must<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** Score one criterion (out of 10) and submit, as the judge. */
export async function review(event: Event, judgeUserId: string, submissionId: string, criterionId: string, value: number) {
  const ctx = await judge(event, judgeUserId);
  must(await saveJudgeScores(ctx, { submissionId, scores: [{ criterionId, score: value }] }));
  must(await submitJudgeReview(ctx, { submissionId, comment: "", submit: true }));
}

/**
 * An event with `titles` projects, judged in round 1 by j1 and j2 with the
 * given scores (one per project, both judges alike) against a target of 2
 * judges per project, round 1 closed and
 * finalised, and a DRAFT round 2 taking advanced finalists with its own rubric.
 */
export async function twoRoundEvent(scores: number[]) {
  const event = await createEvent();
  await grantJudges(event, users.j1, users.j2, users.j3);
  const ctx = await organiser(event);
  const projects = [];
  for (const [index] of scores.entries()) projects.push(await project(event, `Project ${index + 1}`));
  const first = must(await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 10 }));
  must(await setReviewsPerProject(ctx, 2));
  must(await setJudgingStatus(ctx, JudgingStatus.OPEN));
  for (const [index, value] of scores.entries()) {
    await review(event, users.j1, projects[index]!.id, first.id, value);
    await review(event, users.j2, projects[index]!.id, first.id, value);
  }
  must(await setJudgingStatus(ctx, JudgingStatus.CLOSED));
  const roundOne = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
  must(await finalizeJudgingRound(ctx, roundOne.id, {}));
  const roundTwo = must(await createJudgingRound(ctx, { name: "Finals", entrySource: "ADVANCED", judgesSeeAll: true, freshEyes: false, reviewsPerProject: "", scoreNormalization: "RAW", opensAt: "", closesAt: "" }));
  const second = must(await createJudgingCriterion(ctx, { name: "Pitch", weight: 1, maxScore: 10 }, { roundId: roundTwo.id }));
  return { event, ctx, projects, roundOneId: roundOne.id, roundTwoId: roundTwo.id, firstCriterionId: first.id, secondCriterionId: second.id };
}

export async function openRound(ctx: JudgingOrganiserContext, roundId: string) {
  must(await setJudgingRoundStatus(ctx, roundId, "OPEN"));
}

export async function setUpRounds() {
  const [org, other] = await Promise.all([
    prisma.organisation.create({ data: { name: `Rounds ${suffix}`, slug: orgSlug } }),
    prisma.organisation.create({ data: { name: `Rounds other ${suffix}`, slug: otherOrgSlug } }),
  ]);
  organisationId = org.id;
  otherOrganisationId = other.id;
  for (const key of Object.keys(users) as Array<keyof typeof users>) {
    const user = await prisma.user.create({ data: { name: `User ${key}`, email: `${key}-${suffix}@example.test`, emailVerified: new Date() } });
    users[key] = user.id;
  }
  await prisma.membership.create({ data: { userId: users.owner, organisationId, role: MembershipRole.OWNER } });
  await prisma.membership.create({ data: { userId: users.owner, organisationId: otherOrganisationId, role: MembershipRole.OWNER } });
}

export async function tearDownRounds() {
  for (const id of [organisationId, otherOrganisationId]) if (id) await prisma.organisation.delete({ where: { id } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).filter(Boolean) } } });
  await prisma.outboxMessage.deleteMany({ where: { createdAt: { gte: startedAt } } });
  await prisma.auditEvent.deleteMany({ where: { createdAt: { gte: startedAt }, OR: [{ action: { startsWith: "JUDG" } }, { action: { startsWith: "SUBMISSION_" } }] } });
  await prisma.$disconnect();
}
