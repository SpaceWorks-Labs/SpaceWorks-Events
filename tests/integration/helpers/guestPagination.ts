import { randomUUID } from "node:crypto";
import { EventPermission, EventPrivacyType, EventStatus, MembershipRole, RegistrationMode, RsvpStatus, type Event } from "@prisma/client";
import { expect } from "vitest";
import { prisma } from "@/lib/db";
import { resolveOrganiserEvent, type OrganiserEventContext } from "@/lib/core/teams";
import { teamNameKey } from "@/lib/validators";

/*
 * Shared seed for the guest and check-in paging suites. Each test file seeds
 * its own organisations (own suffix) in beforeAll and removes them after.
 */

export const suffix = randomUUID().replaceAll("-", "");
export const orgSlug = `paging-${suffix}`;
export const otherOrgSlug = `paging-other-${suffix}`;
export let organisationId = "";
export let otherOrganisationId = "";
export let adminId = "";
export let memberId = "";
export let otherAdminId = "";
export let checkInHelperId = "";
export let inviterId = "";
export let event: Event;
export let otherEvent: Event;
export let organiser: OrganiserEventContext;
let sequence = 0;

const base = new Date("2030-03-01T09:00:00.000Z");
export const minutes = (n: number) => new Date(base.getTime() + n * 60_000);

async function createEvent(organisation: string, teamMaxSize = 3) {
  return prisma.event.create({ data: {
    organisationId: organisation,
    title: `Paging ${suffix}`,
    slug: `paging-${suffix}-${randomUUID().slice(0, 8)}`,
    startDateTime: new Date("2035-01-01T10:00:00.000Z"),
    endDateTime: new Date("2035-01-02T10:00:00.000Z"),
    timezone: "UTC",
    status: EventStatus.PUBLISHED,
    privacyType: EventPrivacyType.PUBLIC,
    registrationMode: RegistrationMode.TEAM,
    teamMaxSize,
    page: { create: { isPublished: true } },
  } });
}

async function createTeam(target: Event, name: string, status: RsvpStatus, createdAt: Date) {
  return prisma.team.create({ data: {
    eventId: target.id,
    name,
    nameKey: teamNameKey(name),
    status,
    joinToken: randomUUID(),
    manageTokenHash: randomUUID(),
    createdAt,
  } });
}

async function addRsvp(target: Event, data: { status?: RsvpStatus; createdAt: Date; name?: string; teamId?: string | null; userId?: string | null; checkedInAt?: Date | null }) {
  sequence += 1;
  const email = `guest-${sequence}-${suffix}@example.test`;
  return prisma.rSVP.create({ data: {
    eventId: target.id,
    guestEmail: data.userId ? null : email,
    guestName: data.userId ? null : data.name ?? `Guest ${sequence}`,
    userId: data.userId ?? null,
    attendeeKey: data.userId ? `user:${data.userId}` : `guest:${email}`,
    status: data.status ?? RsvpStatus.CONFIRMED,
    teamId: data.teamId ?? null,
    createdAt: data.createdAt,
    checkedInAt: data.checkedInAt ?? null,
  } });
}

/** Walk every page of a cursor list. */
export async function walk<R>(fetch: (cursor: string | null) => Promise<{ rows: R[]; nextCursor: string | null }>, pageSize: number) {
  const rows: R[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await fetch(cursor);
    expect(page.rows.length).toBeLessThanOrEqual(pageSize);
    if (page.nextCursor) expect(page.rows.length).toBe(pageSize);
    rows.push(...page.rows);
    cursor = page.nextCursor;
    pages += 1;
    expect(pages).toBeLessThan(100);
  } while (cursor);
  return { rows, pages };
}

/** Two organisations, their staff, the paged event (40 teams, 120 solos, two signed-in guests) and lookalike data elsewhere. */
export async function seedGuestPaging() {
  const [org, otherOrg] = await Promise.all([
    prisma.organisation.create({ data: { name: `Paging ${suffix}`, slug: orgSlug } }),
    prisma.organisation.create({ data: { name: `Paging other ${suffix}`, slug: otherOrgSlug } }),
  ]);
  organisationId = org.id;
  otherOrganisationId = otherOrg.id;
  const users = await Promise.all(
    ["admin", "member", "other-admin", "checkin-helper", "inviter", "signed-in-a", "signed-in-b"].map((label) =>
      prisma.user.create({ data: { name: `Paging ${label}`, email: `${label}-${suffix}@example.test` } }),
    ),
  );
  [adminId, memberId, otherAdminId, checkInHelperId, inviterId] = users.map((user) => user.id) as [string, string, string, string, string];
  await prisma.membership.createMany({ data: [
    { userId: adminId, organisationId, role: MembershipRole.ADMIN },
    { userId: memberId, organisationId, role: MembershipRole.MEMBER },
    { userId: otherAdminId, organisationId: otherOrganisationId, role: MembershipRole.ADMIN },
  ] });

  event = await createEvent(organisationId);
  otherEvent = await createEvent(otherOrganisationId);
  await prisma.eventCollaborator.createMany({ data: [
    { eventId: event.id, userId: checkInHelperId, permissions: [EventPermission.CHECK_IN] },
    { eventId: event.id, userId: inviterId, permissions: [EventPermission.MANAGE_INVITATIONS] },
  ] });

  // 40 teams, alphabetical names out of creation order: every fourth one
  // full (3 members), "Zulu declined" rejected, the rest with 1 member.
  const teams = [];
  for (let i = 0; i < 40; i += 1) {
    const name = `Team ${String((i * 7) % 40).padStart(2, "0")} ${i % 2 ? "alpha" : "Beta"}`;
    teams.push(await createTeam(event, name, RsvpStatus.CONFIRMED, minutes(i)));
  }
  const rejected = await createTeam(event, "Zulu declined", RsvpStatus.REJECTED, minutes(31));
  let at = 0;
  for (const [index, team] of teams.entries()) {
    const size = index % 4 === 0 ? 3 : 1;
    for (let m = 0; m < size; m += 1) {
      const rsvp = await addRsvp(event, { createdAt: minutes(100 + at), teamId: team.id, name: `Member ${team.name} ${m}`, checkedInAt: at % 2 === 0 ? minutes(1000 + Math.floor(at / 4)) : null });
      at += 1;
      if (m === 0) await prisma.team.update({ where: { id: team.id }, data: { leaderRsvpId: rsvp.id } });
    }
  }
  const declinedLeader = await addRsvp(event, { status: RsvpStatus.REJECTED, createdAt: minutes(99), teamId: rejected.id });
  await prisma.team.update({ where: { id: rejected.id }, data: { leaderRsvpId: declinedLeader.id } });
  // 120 solo registrations with mixed statuses (half confirmed); ten share
  // one createdAt to exercise the id tie-break. Together every list here
  // spans more than one page: guests, check-ins and the list roster.
  const statuses = [RsvpStatus.CONFIRMED, RsvpStatus.WAITLISTED, RsvpStatus.CONFIRMED, RsvpStatus.PENDING_APPROVAL, RsvpStatus.CONFIRMED, RsvpStatus.REJECTED];
  for (let i = 0; i < 120; i += 1) {
    await addRsvp(event, { status: statuses[i % statuses.length], createdAt: i < 10 ? minutes(500) : minutes(200 + i), name: i === 42 ? "Ada Needle" : undefined });
  }
  await addRsvp(event, { createdAt: minutes(600), userId: users[5]!.id });
  await addRsvp(event, { createdAt: minutes(601), userId: users[6]!.id, checkedInAt: minutes(2000) });
  // Another organisation's event with lookalike data.
  await addRsvp(otherEvent, { createdAt: minutes(1), name: "Ada Needle" });
  await createTeam(otherEvent, "Team 00 Beta", RsvpStatus.CONFIRMED, minutes(1));

  const ctx = await resolveOrganiserEvent(adminId, orgSlug, event.id);
  if (!ctx) throw new Error("organiser context missing");
  organiser = ctx;
}

export async function tearDownGuestPaging() {
  if (organisationId) await prisma.organisation.delete({ where: { id: organisationId } });
  if (otherOrganisationId) await prisma.organisation.delete({ where: { id: otherOrganisationId } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${suffix}@example.test` } } });
}
