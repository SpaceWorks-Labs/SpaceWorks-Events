import { randomUUID } from "node:crypto";
import { EventPrivacyType, EventStatus, MembershipRole, RegistrationMode, SoloPolicy, type Event } from "@prisma/client";
import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { countConfirmedForCapacity } from "@/lib/teamUnits";
import { addCrewMemberAsOrganiser, type OrganiserCrewContext } from "@/lib/core/crew";
import type { TeamRegistrationIntent } from "@/lib/validators";

/*
 * Shared setup for the event crew suites (docs/CREW.md): an organisation with
 * an admin, a second organisation for tenancy checks, and helpers to create
 * events, register guests and add crew. Callers mock `@/lib/auth`,
 * `@/lib/actionRateLimit` and `next/cache` first.
 */

export const crew = { suffix: randomUUID().replaceAll("-", ""), orgSlug: "", organisationId: "", otherOrganisationId: "", organiserId: "", otherOrganiserId: "", startedAt: new Date() };
let sequence = 0;

export async function setUpCrewOrgs(label: string) {
  crew.orgSlug = `crew-${label}-${crew.suffix}`;
  const [org, otherOrg] = await Promise.all([
    prisma.organisation.create({ data: { name: `Crew ${label}`, slug: crew.orgSlug } }),
    prisma.organisation.create({ data: { name: `Crew other ${label}`, slug: `crew-other-${label}-${crew.suffix}` } }),
  ]);
  crew.organisationId = org.id;
  crew.otherOrganisationId = otherOrg.id;
  const [user, otherUser] = await Promise.all([
    prisma.user.create({ data: { name: "Crew organiser", email: `organiser-${label}-${crew.suffix}@example.test` } }),
    prisma.user.create({ data: { name: "Other organiser", email: `other-organiser-${label}-${crew.suffix}@example.test` } }),
  ]);
  crew.organiserId = user.id;
  crew.otherOrganiserId = otherUser.id;
  await prisma.membership.createMany({ data: [
    { userId: user.id, organisationId: org.id, role: MembershipRole.ADMIN },
    { userId: otherUser.id, organisationId: otherOrg.id, role: MembershipRole.ADMIN },
  ] });
}

export async function tearDownCrewOrgs() {
  await prisma.organisation.deleteMany({ where: { id: { in: [crew.organisationId, crew.otherOrganisationId].filter(Boolean) } } });
  await prisma.user.deleteMany({ where: { id: { in: [crew.organiserId, crew.otherOrganiserId].filter(Boolean) } } });
  await prisma.outboxMessage.deleteMany({ where: { createdAt: { gte: crew.startedAt } } });
  await prisma.$disconnect();
}

export type CrewEventOptions = { capacity?: number; registrationMode?: RegistrationMode; status?: EventStatus; ended?: boolean; privacyType?: EventPrivacyType };

export async function createCrewEvent(options: CrewEventOptions = {}) {
  const team = options.registrationMode === RegistrationMode.TEAM;
  return prisma.event.create({ data: {
    organisationId: crew.organisationId,
    title: `Crew ${crew.suffix}`,
    slug: `crew-${crew.suffix}-${randomUUID().slice(0, 8)}`,
    startDateTime: options.ended ? new Date("2020-01-01T10:00:00.000Z") : new Date("2035-01-01T10:00:00.000Z"),
    endDateTime: options.ended ? new Date("2020-01-02T10:00:00.000Z") : new Date("2035-01-02T10:00:00.000Z"),
    timezone: "UTC",
    status: options.status ?? EventStatus.PUBLISHED,
    privacyType: options.privacyType ?? EventPrivacyType.PUBLIC,
    capacity: options.capacity,
    registrationMode: options.registrationMode ?? RegistrationMode.INDIVIDUAL,
    teamMaxSize: team ? 4 : undefined,
    soloPolicy: SoloPolicy.SOLO_ALLOWED,
    page: { create: { isPublished: true } },
  } });
}

export function ctxFor(event: Event, organisationId = crew.organisationId): OrganiserCrewContext {
  return { organisationId, eventId: event.id, actorUserId: crew.organiserId };
}

export function crewEmail(label: string) {
  sequence += 1;
  return `${label}-${sequence}-${crew.suffix}@example.test`;
}

export async function register(event: Event, label: string, team?: TeamRegistrationIntent) {
  const guestEmail = crewEmail(label);
  const result = await submitRsvpCore({ orgSlug: crew.orgSlug, eventSlug: event.slug, guestEmail, name: `${label} Person`, answers: {} }, { userId: null, ...(team ? { team } : {}) });
  if (!result.ok || !result.data) throw new Error(`registration failed: ${result.ok ? "no data" : result.error}`);
  const rsvp = await prisma.rSVP.findUniqueOrThrow({ where: { checkInToken: result.data.ticketToken } });
  return { rsvp, email: guestEmail };
}

export async function addCrew(event: Event, overrides: Record<string, unknown> = {}) {
  const memberEmail = (overrides.email as string | undefined) ?? crewEmail("crew");
  const result = await addCrewMemberAsOrganiser(ctxFor(event), { name: "Crew Person", email: memberEmail, foodPreference: "Vegan", role: "Logistics", ...overrides });
  if (!result.ok) throw new Error(`add crew failed: ${result.error}`);
  return prisma.eventCrewMember.findUniqueOrThrow({ where: { id: result.data.id }, include: { rsvp: true } });
}

export function capacityCount(event: Event) {
  return prisma.$transaction((tx) => countConfirmedForCapacity(tx, event.id, event.registrationMode));
}
