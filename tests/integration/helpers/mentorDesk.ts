import { randomUUID } from "node:crypto";
import { EventPermission, EventPrivacyType, EventStatus, RegistrationMode, SoloPolicy, type Event } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hashTeamManageToken } from "@/lib/teamToken";
import { zonedDatetimeLocalValue } from "@/lib/timeZone";
import { resolveDeskOrganiser, resolveMentorContext, resolveParticipantByManageToken, type MentorContext, type ParticipantContext } from "@/lib/core/mentorDesk/access";
import { saveHelpCategory } from "@/lib/core/mentorDesk/configuration";
import { createUser, organisationId, organiserId, orgSlug, otherOrganisationId, otherOrgSlug, suffix } from "./judging";

/*
 * docs/MENTOR_DESK.md "Tests": shared fixture for the mentor-desk-* suites.
 * Builds on the judging fixture (organisations, users, registrations); each
 * suite calls setUpJudgingSuite / tearDownJudgingSuite itself.
 */

export const HOUR = 3_600_000;

/**
 * A TEAM event with the desk on, starting in an hour (so teams can still
 * register); `goLive` then moves its start into the past.
 */
export async function createDeskEvent(options: { organisation?: string; enabled?: boolean; endsInMs?: number } = {}): Promise<Event> {
  return prisma.event.create({ data: {
    organisationId: options.organisation ?? organisationId,
    title: `Mentor ${suffix}`,
    slug: `mentor-${suffix}-${randomUUID().slice(0, 8)}`,
    startDateTime: new Date(Date.now() + HOUR),
    endDateTime: new Date(Date.now() + (options.endsInMs ?? 5 * HOUR)),
    timezone: "UTC",
    status: EventStatus.PUBLISHED,
    privacyType: EventPrivacyType.PUBLIC,
    registrationMode: RegistrationMode.TEAM,
    teamMaxSize: 4,
    soloPolicy: SoloPolicy.SOLO_ALLOWED,
    mentorDeskEnabled: options.enabled ?? true,
    page: { create: { isPublished: true } },
  } });
}

/** The event started an hour ago. */
export async function goLive(event: Event): Promise<Event> {
  return prisma.event.update({ where: { id: event.id }, data: { startDateTime: new Date(Date.now() - HOUR) } });
}

export function slugOf(event: Event) {
  return event.organisationId === otherOrganisationId ? otherOrgSlug : orgSlug;
}

export async function organiserOf(event: Event, userId = organiserId) {
  const ctx = await resolveDeskOrganiser(userId, slugOf(event), event.id);
  if (!ctx) throw new Error("organiser context missing");
  return ctx;
}

/** A user holding the MENTOR grant with a profile available for the whole event. */
export async function addMentor(event: Event, label: string, profile: { skills?: string[]; maxActiveTeams?: number; availability?: Array<{ startsAt: Date; endsAt: Date }> } = {}): Promise<MentorContext> {
  const user = await createUser(label);
  await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: user.id, permissions: [EventPermission.MENTOR] } });
  const windows = profile.availability ?? [{ startsAt: event.startDateTime, endsAt: event.endDateTime }];
  await prisma.mentorProfile.create({ data: {
    eventId: event.id, userId: user.id, skills: profile.skills ?? [], maxActiveTeams: profile.maxActiveTeams ?? 4,
    availability: windows.map((w) => ({ startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString() })),
  } });
  const ctx = await resolveMentorContext(user.id, slugOf(event), event.id);
  if (!ctx) throw new Error("mentor context missing");
  return ctx;
}

export async function addCategory(event: Event, input: { key: string; skillTags?: string[]; openLimit?: number; claimMinutes?: number; expiryMinutes?: number; priority?: number }) {
  const result = await saveHelpCategory(await organiserOf(event), { expectedVersion: 0, label: input.key, ...input });
  if (!result.ok) throw new Error(result.error);
  return result.data.id;
}

/** The team's management link resolves to a participant (the raw token only exists in the outbox). */
export async function teamParticipant(teamId: string): Promise<ParticipantContext> {
  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { manageTokenHash: true } });
  const messages = await prisma.outboxMessage.findMany({ where: { kind: "team-created", payload: { path: ["teamId"], equals: teamId } } });
  const token = messages.map((m) => (m.payload as { manageToken?: string }).manageToken).find((raw) => raw && hashTeamManageToken(raw) === team.manageTokenHash);
  const ctx = token ? await resolveParticipantByManageToken(token) : null;
  if (!ctx) throw new Error("participant context missing");
  return ctx;
}

/** A datetime-local value in UTC (the fixture events use UTC). */
export function local(date: Date) {
  return zonedDatetimeLocalValue(date, "UTC");
}

export async function requestVersion(id: string) {
  return (await prisma.helpRequest.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
}

/** The version and lease a mentor's renew, release and resolve send. */
export async function heldClaim(id: string) {
  const row = await prisma.helpRequest.findUniqueOrThrow({ where: { id }, select: { version: true, claimId: true, claimGeneration: true } });
  return { expectedVersion: row.version, claimId: row.claimId ?? undefined, claimGeneration: row.claimGeneration };
}
