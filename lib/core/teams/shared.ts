import "server-only";

import { EventStatus, Prisma, RegistrationMode, SoloPolicy } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { ActionResult } from "@/app/actions/org";
import { isRegistrationClosed } from "@/lib/registrationCutoff";
import { emitTeamWebhooks } from "@/lib/teamUnits";
import type { WebhookEmission } from "@/lib/webhooks/emit";
import { teamNameKey } from "@/lib/validators";

/** Types, messages and locking helpers shared by the team cores in lib/core/teams/. */

export type TeamResult<T = void> = ActionResult<T>;

/** Leader authority, resolved from a management token or a signed-in leader. */
export type TeamLeaderAuth =
  | { kind: "token"; teamId: string; eventId: string; manageTokenHash: string }
  | { kind: "user"; teamId: string; eventId: string; userId: string };

/** The holder of a ticket (check-in) token, for member and seeker actions. */
export type TicketHolder = {
  rsvpId: string;
  eventId: string;
  organisationId: string;
  userId: string | null;
  teamId: string | null;
};

/** An organiser allowed to manage this event's registrations. */
export type OrganiserEventContext = {
  userId: string;
  organisationId: string;
  orgSlug: string;
  eventId: string;
  eventSlug: string;
};

export type JoinRequestActor =
  | { kind: "leader"; auth: TeamLeaderAuth }
  | { kind: "seeker"; holder: TicketHolder };

export const TEAM_NOT_FOUND = "Team not found.";
export const NOT_A_TEAM_EVENT = "This event does not use team registration.";
/** Leader management that only matters for a team that can still take part (rename, links, leadership, matching). */
export const TEAM_DECLINED = "The organisers declined this team, so it can't be changed. You can still remove members or disband it.";
export const INVITE_ONLY_ADD_REFUSED =
  "This event is invite-only. Share your team's join link instead; each person signs in with their invited account to join.";

export function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

export function isUniqueViolationOn(error: unknown, column: string) {
  if (!isUniqueViolation(error)) return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  return Array.isArray(target) ? target.includes(column) : typeof target === "string" && target.includes(column);
}

export function personName(person: { guestName: string | null; user: { name: string | null } | null }) {
  return person.user?.name?.trim() || person.guestName?.trim() || "Guest";
}

export function personEmail(person: { guestEmail: string | null; user: { email: string | null } | null }) {
  return person.user?.email?.trim() || person.guestEmail || null;
}

const lockedEventSelect = {
  id: true,
  title: true,
  slug: true,
  organisationId: true,
  status: true,
  startDateTime: true,
  endDateTime: true,
  registrationClosesAt: true,
  registrationLeadMinutes: true,
  capacity: true,
  privacyType: true,
  registrationMode: true,
  teamMinSize: true,
  teamMaxSize: true,
  soloPolicy: true,
  page: { select: { isPublished: true } },
} satisfies Prisma.EventSelect;

export type LockedEvent = Prisma.EventGetPayload<{ select: typeof lockedEventSelect }>;

/**
 * Run a team mutation and, once it has committed, emit the organisation
 * webhooks it collected (one per member registration that was created,
 * changed status, or was cancelled or removed). Nothing is emitted when the
 * transaction throws and rolls back.
 */
export async function teamTransaction<T>(fn: (tx: Prisma.TransactionClient, webhooks: WebhookEmission[]) => Promise<T>): Promise<T> {
  const webhooks: WebhookEmission[] = [];
  const result = await prisma.$transaction((tx) => fn(tx, webhooks));
  emitTeamWebhooks(webhooks);
  return result;
}

/** Take the Event row lock shared with every capacity change, then read it. */
export async function lockEvent(tx: Prisma.TransactionClient, eventId: string): Promise<LockedEvent | null> {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
  return tx.event.findUnique({ where: { id: eventId }, select: lockedEventSelect });
}

export function isOpenForRegistration(event: LockedEvent) {
  return (
    event.status === EventStatus.PUBLISHED &&
    event.page?.isPublished === true &&
    event.endDateTime > new Date() &&
    !isRegistrationClosed(event)
  );
}

export function hasFreeSpace(event: { teamMaxSize: number | null }, size: number) {
  return event.teamMaxSize != null && size < event.teamMaxSize;
}

/** Re-read the team by (id, eventId) and confirm the caller still leads it. */
export async function lockedLeaderTeam(tx: Prisma.TransactionClient, auth: TeamLeaderAuth) {
  const team = await tx.team.findFirst({
    where: { id: auth.teamId, eventId: auth.eventId },
    select: {
      id: true,
      eventId: true,
      name: true,
      status: true,
      leaderRsvpId: true,
      manageTokenHash: true,
      lookingForMembers: true,
      leaderRsvp: { select: { userId: true, guestName: true, user: { select: { name: true } } } },
    },
  });
  if (!team) return null;
  if (auth.kind === "token" && team.manageTokenHash !== auth.manageTokenHash) return null;
  if (auth.kind === "user" && team.leaderRsvp?.userId !== auth.userId) return null;
  return team;
}

export async function renameTeamTx(tx: Prisma.TransactionClient, team: { id: string; eventId: string }, name: string): Promise<TeamResult<{ name: string }>> {
  const nameKey = teamNameKey(name);
  const taken = await tx.team.findFirst({ where: { eventId: team.eventId, nameKey, id: { not: team.id } }, select: { id: true } });
  if (taken) return fail("That team name is already taken for this event.");
  await tx.team.update({ where: { id: team.id }, data: { name, nameKey } });
  return { ok: true, data: { name } };
}

export function isMatchingEvent(event: Pick<LockedEvent, "registrationMode" | "soloPolicy">) {
  return event.registrationMode === RegistrationMode.TEAM && event.soloPolicy === SoloPolicy.SOLO_WITH_MATCHING;
}

/** Leader authority still holds for this team row (rotated token or transferred leadership fail). */
export function leaderAuthMatches(auth: TeamLeaderAuth, team: { manageTokenHash: string; leaderRsvp: { userId: string | null } | null }) {
  return auth.kind === "token" ? team.manageTokenHash === auth.manageTokenHash : team.leaderRsvp?.userId === auth.userId;
}
