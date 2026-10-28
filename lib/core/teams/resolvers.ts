import "server-only";

import { prisma } from "@/lib/db";
import { canManageRegistrationsFor } from "@/lib/eventAccess";
import { hashTeamManageToken, isTeamTokenShape } from "@/lib/teamToken";
import { ticketTokenSchema } from "@/lib/validators";
import type { OrganiserEventContext, TeamLeaderAuth, TicketHolder } from "./shared";

// ---------------------------------------------------------------------------
// Authorisation resolvers
// ---------------------------------------------------------------------------

/** `/team/{manageToken}`: the raw token is hashed and never stored or logged. */
export async function resolveTeamByManageToken(rawToken: string): Promise<TeamLeaderAuth | null> {
  if (!isTeamTokenShape(rawToken)) return null;
  const manageTokenHash = hashTeamManageToken(rawToken);
  const team = await prisma.team.findUnique({ where: { manageTokenHash }, select: { id: true, eventId: true } });
  return team ? { kind: "token", teamId: team.id, eventId: team.eventId, manageTokenHash } : null;
}

/** A signed-in leader reaching the team page from Account → Registrations. */
export async function resolveLeaderForUser(userId: string, teamId: string): Promise<TeamLeaderAuth | null> {
  if (!userId || !teamId || teamId.length > 128) return null;
  const team = await prisma.team.findFirst({
    where: { id: teamId, leaderRsvp: { userId } },
    select: { id: true, eventId: true },
  });
  return team ? { kind: "user", teamId: team.id, eventId: team.eventId, userId } : null;
}

/**
 * The ticket token identifies a registration for member and seeker actions.
 * Like cancellation, a registration owned by an account also needs that
 * account signed in for mutations (`requireOwner`, the default); a guest
 * registration is proven by the token alone. Read-only views may pass
 * `requireOwner: false`, matching the ticket page. Never grants team
 * management.
 */
export async function resolveRsvpByTicketToken(
  rawToken: string,
  actorUserId: string | null,
  opts: { requireOwner?: boolean } = {},
): Promise<TicketHolder | null> {
  const parsed = ticketTokenSchema.safeParse(rawToken);
  if (!parsed.success) return null;
  const rsvp = await prisma.rSVP.findUnique({
    where: { checkInToken: parsed.data },
    select: { id: true, eventId: true, userId: true, teamId: true, event: { select: { organisationId: true } } },
  });
  if (!rsvp?.eventId || !rsvp.event) return null;
  if (opts.requireOwner !== false && rsvp.userId && rsvp.userId !== actorUserId) return null;
  return { rsvpId: rsvp.id, eventId: rsvp.eventId, organisationId: rsvp.event.organisationId, userId: rsvp.userId, teamId: rsvp.teamId };
}

/**
 * Organiser access to one event's teams: the same check that guards the
 * individual RSVP lifecycle (`canManageRegistrationsFor`: organisation
 * OWNER/ADMIN or the event's MANAGE_REGISTRATIONS grant), with the event
 * re-read inside the organisation.
 */
export async function resolveOrganiserEvent(
  userId: string,
  organisationSlug: string,
  eventId: string,
): Promise<OrganiserEventContext | null> {
  const org = await prisma.organisation.findUnique({ where: { slug: organisationSlug }, select: { id: true, slug: true } });
  if (!org) return null;
  const event = await prisma.event.findFirst({ where: { id: eventId, organisationId: org.id }, select: { id: true, slug: true } });
  if (!event) return null;
  if (!(await canManageRegistrationsFor({ userId, organisationId: org.id, eventId: event.id }))) return null;
  return { userId, organisationId: org.id, orgSlug: org.slug, eventId: event.id, eventSlug: event.slug };
}
