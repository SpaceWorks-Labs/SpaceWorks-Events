import "server-only";

/*
 * Who may do what on the Mentor Desk (docs/MENTOR_DESK.md). The organisation
 * comes from its slug, the event is re-read inside it, and every context
 * carries ids only. Commands re-check the live grant inside their own
 * transaction (lockMentor), so a revoked grant or an off-shift mentor is
 * refused even with a context resolved a moment earlier.
 */

import { EventPermission, Prisma, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getMembership, isOrgAdmin } from "@/lib/permissions";
import { staffMfaSatisfied } from "@/lib/staffMfa";
import { hashTeamManageToken, isTeamTokenShape } from "@/lib/teamToken";
import { inWindows, parseAvailability } from "@/lib/mentorDesk/rules";
import { COPY, refuse, shareEvent } from "./shared";

export type DeskEventRef = { userId: string; organisationId: string; orgSlug: string; eventId: string; eventSlug: string };
/** Organisation OWNER/ADMIN: manages the desk. */
export type DeskOrganiserContext = DeskEventRef & { kind: "organiser" };
/** A MENTOR grant holder who passed the staff authenticator check. */
export type MentorContext = DeskEventRef & { kind: "mentor" };

/** A participant proved by their signed-in account (CONFIRMED RSVP) or by the team's management link. */
export type ParticipantContext =
  | { kind: "account"; userId: string; organisationId: string; eventId: string; rsvpId: string; teamId: string | null }
  | { kind: "team-token"; userId: null; organisationId: string; eventId: string; teamId: string; manageTokenHash: string };

async function eventInOrg(orgSlug: string, eventId: string) {
  if (!orgSlug || orgSlug.length > 128 || !eventId || eventId.length > 128) return null;
  const org = await prisma.organisation.findUnique({ where: { slug: orgSlug }, select: { id: true, slug: true } });
  if (!org) return null;
  const event = await prisma.event.findFirst({ where: { id: eventId, organisationId: org.id }, select: { id: true, slug: true, mentorDeskEnabled: true } });
  return event ? { org, event } : null;
}

/** Organisation OWNER/ADMIN of the event's organisation (getMembership applies staff MFA). */
export async function resolveDeskOrganiser(userId: string, orgSlug: string, eventId: string): Promise<DeskOrganiserContext | null> {
  if (!userId) return null;
  const found = await eventInOrg(orgSlug, eventId);
  if (!found) return null;
  const membership = await getMembership(userId, found.org.id);
  if (!membership || !isOrgAdmin(membership.role)) return null;
  return { kind: "organiser", userId, organisationId: found.org.id, orgSlug: found.org.slug, eventId: found.event.id, eventSlug: found.event.slug };
}

/** A MENTOR collaborator on an event with the desk on, past the staff authenticator check. */
export async function resolveMentorContext(userId: string, orgSlug: string, eventId: string): Promise<MentorContext | null> {
  if (!userId) return null;
  const found = await eventInOrg(orgSlug, eventId);
  if (!found || !found.event.mentorDeskEnabled) return null;
  const grant = await prisma.eventCollaborator.findFirst({ where: { eventId: found.event.id, userId, permissions: { has: EventPermission.MENTOR } }, select: { id: true } });
  if (!grant || !(await staffMfaSatisfied(userId))) return null;
  return { kind: "mentor", userId, organisationId: found.org.id, orgSlug: found.org.slug, eventId: found.event.id, eventSlug: found.event.slug };
}

export type LockedEvent = { id: string; organisationId: string; title: string; timezone: string; startDateTime: Date; endDateTime: Date; mentorDeskEnabled: boolean; mentorHelpClaimedEmail: boolean };

const lockedEventSelect = { id: true, organisationId: true, title: true, timezone: true, startDateTime: true, endDateTime: true, mentorDeskEnabled: true, mentorHelpClaimedEmail: true } as const;

/** The event, re-read in the caller's transaction; refused when the desk is off or the event moved. */
export async function deskEvent(tx: Prisma.TransactionClient, ref: { eventId: string; organisationId: string }, options: { allowDisabled?: boolean } = {}): Promise<LockedEvent> {
  const event = await tx.event.findFirst({ where: { id: ref.eventId, organisationId: ref.organisationId }, select: lockedEventSelect });
  if (!event) refuse(COPY.notFound);
  if (!event.mentorDeskEnabled && !options.allowDisabled) refuse(COPY.disabled);
  return event;
}

export type LiveMentor = { userId: string; skills: string[]; maxActiveTeams: number; availability: ReturnType<typeof parseAvailability>; profileId: string; profileVersion: number };

/**
 * policy.mentor_for: the live MENTOR grant and profile, checked inside the
 * transaction. `at` defaults to now; `onShift: false` skips the availability
 * window (profile edits, conflict declarations, nominations). The grant row
 * is read FOR SHARE, so a grant removal (which locks it FOR UPDATE before its
 * cleanup, ./grant.ts) waits for the command or the command sees it gone.
 * `exclusive` reads it FOR UPDATE instead, serialising the mentor's schedule
 * changes (office-hour slot creation and rescheduling check overlaps under
 * it). It must be the transaction's first lock on the grant: a shared lock
 * is never upgraded.
 */
export async function liveMentor(tx: Prisma.TransactionClient, eventId: string, userId: string, options: { at?: Date; onShift?: boolean; exclusive?: boolean } = {}): Promise<LiveMentor> {
  // Every caller fences Event before the grant, including conflict inserts
  // whose Event foreign key would otherwise invert acceptance's locks.
  await shareEvent(tx, eventId);
  if (options.exclusive) await tx.$queryRaw`SELECT "id" FROM "EventCollaborator" WHERE "eventId" = ${eventId} AND "userId" = ${userId} FOR UPDATE`;
  else await tx.$queryRaw`SELECT "id" FROM "EventCollaborator" WHERE "eventId" = ${eventId} AND "userId" = ${userId} FOR SHARE`;
  const [grant, profile] = await Promise.all([
    tx.eventCollaborator.findFirst({ where: { eventId, userId, permissions: { has: EventPermission.MENTOR } }, select: { id: true } }),
    tx.mentorProfile.findUnique({ where: { eventId_userId: { eventId, userId } }, select: { id: true, version: true, skills: true, maxActiveTeams: true, availability: true } }),
  ]);
  if (!grant || !profile) refuse(COPY.notMentor);
  const availability = parseAvailability(profile.availability);
  if ((options.onShift ?? true) && !inWindows(availability, options.at ?? new Date())) refuse(COPY.offShift);
  return { userId, skills: profile.skills, maxActiveTeams: profile.maxActiveTeams, availability, profileId: profile.id, profileVersion: profile.version };
}

/**
 * The signed-in owner of a CONFIRMED registration on the event (a ticket QR
 * alone is never enough). A crew ticket is not a participant place: crew
 * never use the desk as participants (docs/CREW.md).
 */
export async function resolveParticipantForUser(userId: string, orgSlug: string, eventId: string): Promise<ParticipantContext | null> {
  if (!userId) return null;
  const found = await eventInOrg(orgSlug, eventId);
  if (!found || !found.event.mentorDeskEnabled) return null;
  const rsvp = await prisma.rSVP.findFirst({
    where: { eventId: found.event.id, userId, status: RsvpStatus.CONFIRMED, isCrew: false },
    select: { id: true, teamId: true, team: { select: { status: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (!rsvp) return null;
  const teamId = rsvp.teamId && rsvp.team?.status === RsvpStatus.CONFIRMED ? rsvp.teamId : null;
  if (rsvp.teamId && !teamId) return null;
  return { kind: "account", userId, organisationId: found.org.id, eventId: found.event.id, rsvpId: rsvp.id, teamId };
}

/** The team's management link (a bearer capability) on a CONFIRMED team. */
export async function resolveParticipantByManageToken(rawToken: string): Promise<ParticipantContext | null> {
  if (!isTeamTokenShape(rawToken)) return null;
  const manageTokenHash = hashTeamManageToken(rawToken);
  const team = await prisma.team.findUnique({ where: { manageTokenHash }, select: { id: true, status: true, event: { select: { id: true, organisationId: true, mentorDeskEnabled: true } } } });
  if (!team || team.status !== RsvpStatus.CONFIRMED || !team.event.mentorDeskEnabled) return null;
  return { kind: "team-token", userId: null, organisationId: team.event.organisationId, eventId: team.event.id, teamId: team.id, manageTokenHash };
}

/** Re-proves a participant inside the transaction; returns the request scope (team or solo RSVP). */
export async function liveParticipant(tx: Prisma.TransactionClient, p: ParticipantContext): Promise<{ teamId: string | null; rsvpId: string | null }> {
  if (p.kind === "team-token") {
    const team = await tx.team.findFirst({ where: { id: p.teamId, eventId: p.eventId, manageTokenHash: p.manageTokenHash, status: RsvpStatus.CONFIRMED }, select: { id: true } });
    if (!team) refuse(COPY.notFound);
    return { teamId: team.id, rsvpId: null };
  }
  const rsvp = await tx.rSVP.findFirst({ where: { id: p.rsvpId, eventId: p.eventId, userId: p.userId, status: RsvpStatus.CONFIRMED, isCrew: false }, select: { teamId: true, team: { select: { status: true } } } });
  if (!rsvp || rsvp.teamId !== p.teamId || (rsvp.teamId && rsvp.team?.status !== RsvpStatus.CONFIRMED)) refuse(COPY.notFound);
  return p.teamId ? { teamId: p.teamId, rsvpId: null } : { teamId: null, rsvpId: p.rsvpId };
}

/** The user ids registered on a team (teams.member_ids): membership always conflicts. */
export async function teamMemberUserIds(tx: Prisma.TransactionClient, teamId: string): Promise<Set<string>> {
  const rows = await tx.rSVP.findMany({ where: { teamId, userId: { not: null } }, select: { userId: true } });
  return new Set(rows.map((row) => row.userId!));
}
