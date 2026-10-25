import { randomUUID } from "node:crypto";
import {
  EventPermission,
  EventPrivacyType,
  EventStatus,
  MembershipRole,
  RegistrationMode,
  RsvpStatus,
  SoloPolicy,
  type Event,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { resolvePublicJudgingEvent } from "@/lib/publicJudgingPage";
import { hashTeamManageToken } from "@/lib/teamToken";
import { hashSubmissionLinkToken } from "@/lib/submissionToken";
import { resolveJudgeContext, resolveJudgingOrganiser, type JudgeContext, type JudgingOrganiserContext } from "@/lib/judgingAccess";
import {
  createJudgingCriterion,
  requestSubmissionLink,
  resolveEntrantBySubmissionLink,
  resolveEntrantByTeamManageToken,
  updateJudgingSettings,
  type EntrantAuth,
} from "@/lib/core/judging";
import type { TeamRegistrationIntent } from "@/lib/validators";

/*
 * docs/HACKATHON.md "Tests": the scenario suite for submissions, judging, and
 * results against PostgreSQL. lib/core/judging.ts owns every rule; this file
 * drives the cores the way Server Actions and route handlers do.
 *
 * Shared fixture for the judging-{submissions,judges,scoring,entrants,results}
 * suites. Each test file gets its own suffix (so its own organisations and
 * users), mocks `@/lib/auth` itself, and calls setUpJudgingSuite /
 * tearDownJudgingSuite from its beforeAll / afterAll.
 */

export const suffix = randomUUID().replaceAll("-", "");
export const orgSlug = `judging-${suffix}`;
export const otherOrgSlug = `judging-other-${suffix}`;
const startedAt = new Date();
export const HOUR = 3_600_000;

export let organisationId = "";
export let otherOrganisationId = "";
export let organiserId = "";
export let otherOrganiserId = "";
const judgeIds: string[] = [];
const userIds: string[] = [];
let sequence = 0;

type EventOptions = {
  organisation?: string;
  registrationMode?: RegistrationMode;
  privacyType?: EventPrivacyType;
  status?: EventStatus;
  pagePublished?: boolean;
  capacity?: number;
};

export async function createEvent(options: EventOptions = {}): Promise<Event> {
  const mode = options.registrationMode ?? RegistrationMode.TEAM;
  return prisma.event.create({ data: {
    organisationId: options.organisation ?? organisationId,
    title: `Judging ${suffix}`,
    slug: `judging-${suffix}-${randomUUID().slice(0, 8)}`,
    startDateTime: new Date(Date.now() + 24 * HOUR),
    endDateTime: new Date(Date.now() + 48 * HOUR),
    timezone: "UTC",
    status: options.status ?? EventStatus.PUBLISHED,
    privacyType: options.privacyType ?? EventPrivacyType.PUBLIC,
    capacity: options.capacity,
    registrationMode: mode,
    teamMaxSize: mode === RegistrationMode.TEAM ? 4 : undefined,
    soloPolicy: SoloPolicy.SOLO_ALLOWED,
    page: { create: { isPublished: options.pagePublished ?? true } },
  } });
}

function slugFor(event: Event) {
  return event.organisationId === otherOrganisationId ? otherOrgSlug : orgSlug;
}

type Registered = { rsvpId: string; ticketToken: string; teamId: string | null; status: RsvpStatus };

export async function register(event: Event, label: string, options: { team?: TeamRegistrationIntent; userId?: string } = {}): Promise<Registered> {
  sequence += 1;
  const result = await submitRsvpCore(
    {
      orgSlug: slugFor(event),
      eventSlug: event.slug,
      ...(options.userId ? {} : { guestEmail: `${label}-${sequence}-${suffix}@example.test` }),
      name: `${label} Person`,
      answers: {},
    },
    { userId: options.userId ?? null, ...(options.team ? { team: options.team } : {}) },
  );
  if (!result.ok || !result.data) throw new Error(`registration failed: ${result.ok ? "no data" : result.error}`);
  const rsvp = await prisma.rSVP.findUniqueOrThrow({ where: { checkInToken: result.data.ticketToken } });
  return { rsvpId: rsvp.id, ticketToken: result.data.ticketToken, teamId: rsvp.teamId, status: rsvp.status };
}

export async function createTeam(event: Event, name: string, userId?: string) {
  const leader = await register(event, "leader", { team: { mode: "create", name }, userId });
  if (!leader.teamId) throw new Error("team was not created");
  return { leader, teamId: leader.teamId };
}

export async function joinTeam(event: Event, teamId: string, options: { userId?: string; label?: string } = {}) {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId } });
  return register(event, options.label ?? "member", { team: { mode: "join", joinToken: team.joinToken }, userId: options.userId });
}

/** The raw management token only exists in the leader's outbox email; pick the one still valid. */
export async function teamAuth(teamId: string): Promise<EntrantAuth> {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { manageTokenHash: true } });
  const messages = await prisma.outboxMessage.findMany({ where: { kind: "team-created", payload: { path: ["teamId"], equals: teamId } } });
  const token = messages
    .map((message) => (message.payload as { manageToken?: string }).manageToken)
    .find((raw) => raw && hashTeamManageToken(raw) === team.manageTokenHash);
  if (!token) throw new Error("no valid management token queued");
  const auth = await resolveEntrantByTeamManageToken(token);
  if (!auth) throw new Error("management token did not resolve");
  return auth;
}

/** The raw submission token only exists in the emailed link; pick the one matching the stored digest. */
export async function currentSubmissionToken(rsvpId: string) {
  const link = await prisma.submissionLink.findUniqueOrThrow({ where: { rsvpId } });
  const messages = await prisma.outboxMessage.findMany({ where: { kind: "submission-link", payload: { path: ["rsvpId"], equals: rsvpId } } });
  const token = messages
    .map((message) => (message.payload as { token?: string }).token)
    .find((raw) => raw && hashSubmissionLinkToken(raw) === link.tokenHash);
  if (!token) throw new Error("no valid submission link queued");
  return token;
}

export async function soloAuth(rsvpId: string, eventId: string): Promise<EntrantAuth> {
  const requested = await requestSubmissionLink({ rsvpId, eventId });
  if (!requested.ok) throw new Error(requested.error);
  const auth = await resolveEntrantBySubmissionLink(await currentSubmissionToken(rsvpId));
  if (!auth) throw new Error("submission link did not resolve");
  return auth;
}

export async function organiser(event: Event, userId = organiserId): Promise<JudgingOrganiserContext> {
  const ctx = await resolveJudgingOrganiser(userId, slugFor(event), event.id);
  if (!ctx) throw new Error("organiser context missing");
  return ctx;
}

export async function setWindow(ctx: JudgingOrganiserContext, opensAt: Date, closesAt: Date, extra: { judgesSeeAll?: boolean; projectGalleryPublic?: boolean } = {}) {
  const result = await updateJudgingSettings(ctx, {
    submissionsEnabled: true,
    submissionsOpenAt: opensAt.toISOString(),
    submissionsCloseAt: closesAt.toISOString(),
    judgesSeeAll: extra.judgesSeeAll ?? true,
    projectGalleryPublic: extra.projectGalleryPublic ?? true,
  });
  if (!result.ok) throw new Error(result.error);
}

export function openWindow(ctx: JudgingOrganiserContext, extra?: { judgesSeeAll?: boolean; projectGalleryPublic?: boolean }) {
  return setWindow(ctx, new Date(Date.now() - HOUR), new Date(Date.now() + HOUR), extra);
}

/** Close the window by moving it into the past (the gallery then becomes eligible). */
export function closeWindow(ctx: JudgingOrganiserContext, extra?: { judgesSeeAll?: boolean; projectGalleryPublic?: boolean }) {
  return setWindow(ctx, new Date(Date.now() - 2 * HOUR), new Date(Date.now() - HOUR), extra);
}

export async function createUser(label: string) {
  const user = await prisma.user.create({ data: { name: `${label} ${suffix.slice(0, 6)}`, email: `${label}-${randomUUID().slice(0, 8)}-${suffix}@example.test`, emailVerified: new Date() } });
  userIds.push(user.id);
  return user;
}

/** A user holding only the JUDGE grant on `event`. */
export async function createJudge(event: Event, label = "judge"): Promise<{ userId: string; ctx: JudgeContext }> {
  const user = await createUser(label);
  judgeIds.push(user.id);
  await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: user.id, permissions: [EventPermission.JUDGE] } });
  const ctx = await resolveJudgeContext(user.id, slugFor(event), event.id);
  if (!ctx) throw new Error("judge context missing");
  return { userId: user.id, ctx };
}

export async function criterion(ctx: JudgingOrganiserContext, input: { name: string; weight: number; maxScore: number }) {
  const created = await createJudgingCriterion(ctx, input);
  if (!created.ok) throw new Error(created.error);
  return created.data.id;
}

export async function submissionIdFor(entrant: { teamId?: string | null; rsvpId?: string }) {
  const row = await prisma.submission.findFirstOrThrow({ where: entrant.teamId ? { teamId: entrant.teamId } : { rsvpId: entrant.rsvpId } });
  return row.id;
}

/** The `@/lib/auth` mock each test file declares: `vi.fn` resolving the session. */
type AuthMock = { mockResolvedValue: (value: { user: { id: string } } | null) => unknown };

/** Session helpers bound to the calling test file's `@/lib/auth` mock. */
export function judgingSession(authMock: AuthMock) {
  /** Events' Server Actions read the actor from the mocked session. */
  async function as<T>(userId: string, run: () => Promise<T>) {
    authMock.mockResolvedValue(userId ? { user: { id: userId } } : null);
    try { return await run(); } finally { authMock.mockResolvedValue(null); }
  }

  /**
   * What `/{org}/{event}/results` and `/projects` do (docs/HACKATHON.md): the
   * event page's visibility, publication, and invite rules for this viewer
   * first (`resolvePublicJudgingEvent`), then the judging loader. Null is a 404.
   */
  async function publicPage<T>(viewerUserId: string | null, eventId: string, load: (eventId: string) => Promise<T | null>) {
    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId }, select: { slug: true, organisationId: true } });
    authMock.mockResolvedValue(viewerUserId ? { user: { id: viewerUserId } } : null);
    try {
      const resolved = await resolvePublicJudgingEvent(event.organisationId === otherOrganisationId ? otherOrgSlug : orgSlug, event.slug);
      return resolved ? load(resolved.event.id) : null;
    } finally {
      authMock.mockResolvedValue(null);
    }
  }

  return { as, publicPage };
}

export const content = { title: "Byte Me", summary: "A project.", repoUrl: "https://github.com/example/project" };

export async function setUpJudgingSuite() {
  const [org, otherOrg] = await Promise.all([
    prisma.organisation.create({ data: { name: `Judging ${suffix}`, slug: orgSlug } }),
    prisma.organisation.create({ data: { name: `Judging other ${suffix}`, slug: otherOrgSlug } }),
  ]);
  organisationId = org.id;
  otherOrganisationId = otherOrg.id;
  const [owner, otherOwner] = await Promise.all([createUser("organiser"), createUser("other-organiser")]);
  organiserId = owner.id;
  otherOrganiserId = otherOwner.id;
  await prisma.membership.createMany({ data: [
    { userId: organiserId, organisationId, role: MembershipRole.ADMIN },
    { userId: otherOrganiserId, organisationId: otherOrganisationId, role: MembershipRole.ADMIN },
  ] });
}

export async function tearDownJudgingSuite() {
  if (organisationId) await prisma.organisation.delete({ where: { id: organisationId } });
  if (otherOrganisationId) await prisma.organisation.delete({ where: { id: otherOrganisationId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.outboxMessage.deleteMany({ where: { createdAt: { gte: startedAt } } });
  await prisma.auditEvent.deleteMany({ where: { createdAt: { gte: startedAt }, OR: [{ action: { startsWith: "JUDGING_" } }, { action: { startsWith: "SUBMISSION_" } }] } });
  await prisma.$disconnect();
}
