import { randomUUID } from "node:crypto";
import { EventPrivacyType, EventStatus, MembershipRole, RegistrationMode, RsvpStatus, SoloPolicy, type Event } from "@prisma/client";
import { expect } from "vitest";
import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { countConfirmedUnits } from "@/lib/teamUnits";
import { hashTeamManageToken } from "@/lib/teamToken";
import {
  resolveOrganiserEvent,
  resolveRsvpByTicketToken,
  resolveTeamByManageToken,
  TEAM_MATCHING_PAGE_SIZE,
  type CursorPage,
  type OrganiserEventContext,
  type TeamLeaderAuth,
  type TicketHolder,
} from "@/lib/core/teams";
import type { TeamRegistrationIntent } from "@/lib/validators";

/*
 * Shared fixture for the team registration integration suites. Each test file
 * gets its own suffix (so its own organisations and users), seeds them in
 * beforeAll with setUpTeams() and removes them in afterAll with tearDownTeams().
 */

/** Events' Server Actions read the actor from the mocked session. */
export function actingAs(identity: { id: string }) {
  return async function as<T>(userId: string, run: () => Promise<T>) {
    identity.id = userId;
    try { return await run(); } finally { identity.id = ""; }
  };
}

export const suffix = randomUUID().replaceAll("-", "");
export const orgSlug = `teams-${suffix}`;
export const otherOrgSlug = `teams-other-${suffix}`;
const startedAt = new Date();
export let organisationId = "";
export let otherOrganisationId = "";
export let organiserId = "";
export let otherOrganiserId = "";
let sequence = 0;

type EventOptions = {
  capacity?: number;
  privacyType?: EventPrivacyType;
  registrationMode?: RegistrationMode;
  teamMinSize?: number;
  teamMaxSize?: number;
  soloPolicy?: SoloPolicy;
  organisation?: string;
};

export async function createEvent(options: EventOptions = {}) {
  const team = (options.registrationMode ?? RegistrationMode.TEAM) === RegistrationMode.TEAM;
  return prisma.event.create({ data: {
    organisationId: options.organisation ?? organisationId,
    title: `Teams ${suffix}`,
    slug: `teams-${suffix}-${randomUUID().slice(0, 8)}`,
    startDateTime: new Date("2035-01-01T10:00:00.000Z"),
    endDateTime: new Date("2035-01-02T10:00:00.000Z"),
    timezone: "UTC",
    status: EventStatus.PUBLISHED,
    privacyType: options.privacyType ?? EventPrivacyType.PUBLIC,
    capacity: options.capacity,
    registrationMode: options.registrationMode ?? RegistrationMode.TEAM,
    teamMinSize: team ? options.teamMinSize : undefined,
    teamMaxSize: team ? options.teamMaxSize ?? 4 : undefined,
    soloPolicy: options.soloPolicy ?? SoloPolicy.SOLO_ALLOWED,
    page: { create: { isPublished: true } },
  } });
}

function slugFor(event: Event) {
  return event.organisationId === otherOrganisationId ? otherOrgSlug : orgSlug;
}

export async function register(event: Event, label: string, team?: TeamRegistrationIntent) {
  sequence += 1;
  const guestEmail = `${label}-${sequence}-${suffix}@example.test`;
  const result = await submitRsvpCore(
    { orgSlug: slugFor(event), eventSlug: event.slug, guestEmail, name: `${label} Person`, answers: {} },
    { userId: null, ...(team ? { team } : {}) },
  );
  return { result, guestEmail };
}

export type Registered = { rsvpId: string; ticketToken: string; email: string; status: RsvpStatus; teamId: string | null };

export async function registerOk(event: Event, label: string, team?: TeamRegistrationIntent): Promise<Registered> {
  const { result, guestEmail } = await register(event, label, team);
  if (!result.ok || !result.data) throw new Error(`registration failed: ${result.ok ? "no data" : result.error}`);
  const rsvp = await prisma.rSVP.findUniqueOrThrow({ where: { checkInToken: result.data.ticketToken } });
  return { rsvpId: rsvp.id, ticketToken: result.data.ticketToken, email: guestEmail, status: rsvp.status, teamId: rsvp.teamId };
}

export async function createTeam(event: Event, name: string) {
  const leader = await registerOk(event, "leader", { mode: "create", name });
  if (!leader.teamId) throw new Error("team was not created");
  const team = await prisma.team.findUniqueOrThrow({ where: { id: leader.teamId } });
  return { leader, team, manageToken: await currentManageToken(team.id) };
}

export async function joinTeam(event: Event, teamId: string, label = "member") {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId } });
  return registerOk(event, label, { mode: "join", joinToken: team.joinToken });
}

/** The raw management token is only ever in the leader's outbox email; pick the one that is still valid. */
export async function currentManageToken(teamId: string) {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { manageTokenHash: true } });
  const messages = await prisma.outboxMessage.findMany({
    where: { kind: "team-created", payload: { path: ["teamId"], equals: teamId } },
  });
  const token = messages
    .map((message) => (message.payload as { manageToken?: string }).manageToken)
    .find((raw) => raw && hashTeamManageToken(raw) === team.manageTokenHash);
  if (!token) throw new Error("no valid management token queued");
  return token;
}

export async function leaderAuth(teamId: string): Promise<TeamLeaderAuth> {
  const auth = await resolveTeamByManageToken(await currentManageToken(teamId));
  if (!auth) throw new Error("management token did not resolve");
  return auth;
}

export async function organiser(event: Event): Promise<OrganiserEventContext> {
  const ctx = await resolveOrganiserEvent(organiserId, orgSlug, event.id);
  if (!ctx) throw new Error("organiser context missing");
  return ctx;
}

export async function statusOf(rsvpId: string) {
  return (await prisma.rSVP.findUniqueOrThrow({ where: { id: rsvpId } })).status;
}

/**
 * docs/TEAMS.md invariants, checked after every mutation: each member's status
 * equals its team's status, the leader is a member, no team is empty or above
 * `teamMaxSize`, and confirmed units never exceed capacity.
 */
export async function expectTeamInvariants(event: Event) {
  const current = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
  const teams = await prisma.team.findMany({
    where: { eventId: event.id },
    include: { members: { select: { id: true, status: true, eventId: true } } },
  });
  for (const team of teams) {
    expect(team.members.length, `team ${team.name} is empty`).toBeGreaterThan(0);
    for (const member of team.members) {
      expect(member.status, `member of ${team.name}`).toBe(team.status);
      expect(member.eventId).toBe(event.id);
    }
    if (current.teamMaxSize != null) expect(team.members.length).toBeLessThanOrEqual(current.teamMaxSize);
    expect(team.leaderRsvpId).not.toBeNull();
    expect(team.members.map((member) => member.id)).toContain(team.leaderRsvpId);
  }
  if (current.capacity != null) {
    const units = await prisma.$transaction((tx) => countConfirmedUnits(tx, event.id));
    expect(units).toBeLessThanOrEqual(current.capacity);
  }
}

/** Follow `nextCursor` to the end, checking every page's bound and total. */
export async function walkPages<T extends { id: string }>(load: (cursor: string | null) => Promise<CursorPage<T> | null>) {
  const items: T[] = [];
  const totals = new Set<number>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: CursorPage<T> | null = await load(cursor);
    if (!page) throw new Error("page refused");
    expect(page.items.length).toBeLessThanOrEqual(TEAM_MATCHING_PAGE_SIZE);
    if (page.nextCursor) expect(page.items.length).toBe(TEAM_MATCHING_PAGE_SIZE);
    totals.add(page.total);
    items.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
    if (pages > 50) throw new Error("paging did not end");
  } while (cursor);
  return { items, totals: [...totals], pages };
}

export async function seekerHolder(ticketToken: string): Promise<TicketHolder> {
  const holder = await resolveRsvpByTicketToken(ticketToken, null);
  if (!holder) throw new Error("seeker did not resolve");
  return holder;
}

/** The two organisations, each with an admin organiser. */
export async function setUpTeams() {
  const [org, otherOrg] = await Promise.all([
    prisma.organisation.create({ data: { name: `Teams ${suffix}`, slug: orgSlug } }),
    prisma.organisation.create({ data: { name: `Teams other ${suffix}`, slug: otherOrgSlug } }),
  ]);
  organisationId = org.id;
  otherOrganisationId = otherOrg.id;
  const [user, otherUser] = await Promise.all([
    prisma.user.create({ data: { name: "Team organiser", email: `organiser-${suffix}@example.test` } }),
    prisma.user.create({ data: { name: "Other organiser", email: `other-organiser-${suffix}@example.test` } }),
  ]);
  organiserId = user.id;
  otherOrganiserId = otherUser.id;
  await prisma.membership.createMany({ data: [
    { userId: organiserId, organisationId, role: MembershipRole.ADMIN },
    { userId: otherOrganiserId, organisationId: otherOrganisationId, role: MembershipRole.ADMIN },
  ] });
}

export async function tearDownTeams() {
  if (organisationId) await prisma.organisation.delete({ where: { id: organisationId } });
  if (otherOrganisationId) await prisma.organisation.delete({ where: { id: otherOrganisationId } });
  await prisma.user.deleteMany({ where: { id: { in: [organiserId, otherOrganiserId].filter(Boolean) } } });
  await prisma.outboxMessage.deleteMany({ where: { createdAt: { gte: startedAt } } });
  await prisma.$disconnect();
}
