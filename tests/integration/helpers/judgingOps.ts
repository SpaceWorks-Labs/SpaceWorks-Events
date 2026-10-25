import { randomUUID } from "node:crypto";
import { EventPermission, EventStatus, JudgingStatus, MembershipRole, RegistrationMode, SubmissionStatus, type Event } from "@prisma/client";
import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { resolveJudgingOrganiser, type JudgingOrganiserContext } from "@/lib/judgingAccess";

/*
 * Shared state, setup and helpers for tests/integration/judging-ops.db.test.ts,
 * which mocks `@/lib/auth` itself and calls setUpJudgingOps / tearDownJudgingOps.
 */

export const suffix = randomUUID().replaceAll("-", "");
export const orgSlug = `judging-ops-${suffix}`;
const otherOrgSlug = `judging-ops-other-${suffix}`;
const startedAt = new Date();
export const HOUR = 3_600_000;
export let organisationId = "";
export let otherOrganisationId = "";
export const users: Record<"owner" | "admin2" | "j1" | "j2" | "j3" | "j4" | "outsider", string> = { owner: "", admin2: "", j1: "", j2: "", j3: "", j4: "", outsider: "" };
let sequence = 0;

export async function createEvent(orgId: string, slugPrefix = "ops"): Promise<Event> {
  return prisma.event.create({
    data: {
      organisationId: orgId,
      title: `Judging ops ${suffix}`,
      slug: `${slugPrefix}-${suffix}-${randomUUID().slice(0, 8)}`,
      startDateTime: new Date(Date.now() + 24 * HOUR),
      endDateTime: new Date(Date.now() + 48 * HOUR),
      timezone: "UTC",
      status: EventStatus.PUBLISHED,
      registrationMode: RegistrationMode.INDIVIDUAL,
      submissionsEnabled: true,
      judgingStatus: JudgingStatus.OPEN,
      page: { create: { isPublished: true } },
    },
  });
}

async function register(event: Event, userId: string | null = null) {
  sequence += 1;
  const result = await submitRsvpCore(
    { orgSlug, eventSlug: event.slug, ...(userId ? {} : { guestEmail: `entrant-${sequence}-${suffix}@example.test` }), name: `Entrant ${sequence}`, answers: {} },
    { userId },
  );
  if (!result.ok || !result.data) throw new Error(`registration failed: ${result.ok ? "no data" : result.error}`);
  return prisma.rSVP.findUniqueOrThrow({ where: { checkInToken: result.data.ticketToken } });
}

export async function project(event: Event, title: string, userId: string | null = null, status: SubmissionStatus = SubmissionStatus.SUBMITTED) {
  const rsvp = await register(event, userId);
  return prisma.submission.create({ data: { eventId: event.id, rsvpId: rsvp.id, title, status, submittedAt: status === SubmissionStatus.DRAFT ? null : new Date() } });
}

export async function grantJudges(event: Event, ...judgeIds: string[]) {
  for (const userId of judgeIds) await prisma.eventCollaborator.create({ data: { eventId: event.id, userId, permissions: [EventPermission.JUDGE] } });
}

export async function organiser(event: Event): Promise<JudgingOrganiserContext> {
  const ctx = await resolveJudgingOrganiser(users.owner, orgSlug, event.id);
  if (!ctx) throw new Error("organiser context missing");
  return ctx;
}

export async function score(event: Event, submissionId: string, judgeUserId: string, value: number, submitted: boolean) {
  const criterion = await prisma.judgingCriterion.findFirstOrThrow({ where: { eventId: event.id } });
  await prisma.judgeScore.create({ data: { submissionId, judgeUserId, criterionId: criterion.id, score: value } });
  if (submitted) await prisma.judgeReview.create({ data: { submissionId, judgeUserId, submittedAt: new Date() } });
}

export const judgeIds = () => [users.j1, users.j2, users.j3, users.j4];

export async function setUpJudgingOps() {
  const [org, other] = await Promise.all([
    prisma.organisation.create({ data: { name: `Judging ops ${suffix}`, slug: orgSlug } }),
    prisma.organisation.create({ data: { name: `Judging ops other ${suffix}`, slug: otherOrgSlug } }),
  ]);
  organisationId = org.id;
  otherOrganisationId = other.id;
  for (const key of Object.keys(users) as Array<keyof typeof users>) {
    const user = await prisma.user.create({ data: { name: `User ${key}`, email: `${key}-${suffix}@example.test`, emailVerified: new Date() } });
    users[key] = user.id;
  }
  await prisma.membership.create({ data: { userId: users.owner, organisationId, role: MembershipRole.OWNER } });
  await prisma.membership.create({ data: { userId: users.admin2, organisationId, role: MembershipRole.ADMIN } });
  await prisma.membership.create({ data: { userId: users.owner, organisationId: otherOrganisationId, role: MembershipRole.OWNER } });
}

/** Everything after resetting the test file's mocked session. */
export async function tearDownJudgingOps() {
  for (const id of [organisationId, otherOrganisationId]) if (id) await prisma.organisation.delete({ where: { id } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).filter(Boolean) } } });
  await prisma.outboxMessage.deleteMany({ where: { createdAt: { gte: startedAt } } });
  await prisma.auditEvent.deleteMany({ where: { createdAt: { gte: startedAt }, action: { in: ["JUDGES_AUTO_ASSIGNED", "JUDGING_REVIEW_TARGET_UPDATED"] } } });
  await prisma.$disconnect();
}
