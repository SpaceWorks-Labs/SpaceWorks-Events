import "server-only";

/** Entrant proofs: resolve a team leader, member, solo owner or submission link, then re-check it inside a transaction. */

import { Prisma, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveTeamByManageToken } from "@/lib/core/teams";
import { hashSubmissionLinkToken, isSubmissionTokenShape } from "@/lib/submissionToken";
import { entrantDisplayName } from "@/lib/judgingDto";
import { type EntrantAuth, isId, personEmail, personName, personSelect } from "./shared";

// ---------------------------------------------------------------------------
// Entrant resolution
// ---------------------------------------------------------------------------

/** Team leader via `/team/{manageToken}`. The raw token is hashed and never stored or logged. */
export async function resolveEntrantByTeamManageToken(rawToken: string): Promise<EntrantAuth | null> {
  const leader = await resolveTeamByManageToken(rawToken);
  if (!leader || leader.kind !== "token") return null;
  return { kind: "team-token", eventId: leader.eventId, teamId: leader.teamId, manageTokenHash: leader.manageTokenHash };
}

/**
 * A signed-in user on one event: a member of a team (any member may edit the
 * team's submission) or the owner of a solo registration.
 */
export async function resolveEntrantForUser(userId: string, eventId: string): Promise<EntrantAuth | null> {
  if (!isId(userId) || !isId(eventId)) return null;
  // Crew tickets (docs/CREW.md) run the event; they never enter a project.
  const rsvp = await prisma.rSVP.findFirst({ where: { eventId, userId, isCrew: false }, select: { id: true, teamId: true } });
  if (!rsvp) return null;
  return rsvp.teamId
    ? { kind: "team-member", eventId, teamId: rsvp.teamId, userId }
    : { kind: "solo-owner", eventId, rsvpId: rsvp.id, userId };
}

/** `/submit/{token}`: a solo registrant's emailed link. */
export async function resolveEntrantBySubmissionLink(rawToken: string): Promise<EntrantAuth | null> {
  if (!isSubmissionTokenShape(rawToken)) return null;
  const tokenHash = hashSubmissionLinkToken(rawToken);
  const link = await prisma.submissionLink.findUnique({ where: { tokenHash }, select: { rsvpId: true, rsvp: { select: { eventId: true, teamId: true } } } });
  if (!link?.rsvp.eventId || link.rsvp.teamId) return null;
  return { kind: "solo-link", eventId: link.rsvp.eventId, rsvpId: link.rsvpId, tokenHash };
}

type EntrantRow = {
  eventId: string;
  teamId: string | null;
  rsvpId: string | null;
  status: RsvpStatus;
  displayName: string;
  /** Where the submission-received email goes: the person acting. */
  submitter: { email: string | null; name?: string };
};

/** Re-read the entrant by (id, eventId) and confirm the proof still holds. */
export async function lockedEntrant(tx: Prisma.TransactionClient, auth: EntrantAuth): Promise<EntrantRow | null> {
  if (auth.kind === "team-token" || auth.kind === "team-member") {
    const team = await tx.team.findFirst({
      where: { id: auth.teamId, eventId: auth.eventId },
      select: { id: true, name: true, status: true, manageTokenHash: true, leaderRsvp: { select: personSelect } },
    });
    if (!team) return null;
    if (auth.kind === "team-token") {
      if (team.manageTokenHash !== auth.manageTokenHash) return null;
      return {
        eventId: auth.eventId,
        teamId: team.id,
        rsvpId: null,
        status: team.status,
        displayName: team.name,
        submitter: { email: personEmail(team.leaderRsvp), name: personName(team.leaderRsvp) },
      };
    }
    const member = await tx.rSVP.findFirst({ where: { teamId: team.id, eventId: auth.eventId, userId: auth.userId }, select: personSelect });
    if (!member) return null;
    return {
      eventId: auth.eventId,
      teamId: team.id,
      rsvpId: null,
      status: team.status,
      displayName: team.name,
      submitter: { email: personEmail(member), name: personName(member) },
    };
  }
  const rsvp = await tx.rSVP.findFirst({
    where: {
      id: auth.rsvpId,
      eventId: auth.eventId,
      teamId: null,
      isCrew: false,
      ...(auth.kind === "solo-owner" ? { userId: auth.userId } : { submissionLink: { is: { tokenHash: auth.tokenHash } } }),
    },
    select: { id: true, status: true, ...personSelect },
  });
  if (!rsvp) return null;
  return {
    eventId: auth.eventId,
    teamId: null,
    rsvpId: rsvp.id,
    status: rsvp.status,
    displayName: entrantDisplayName({ team: null, rsvp }),
    submitter: { email: personEmail(rsvp), name: personName(rsvp) },
  };
}

/**
 * Serialise writes for one entrant: lock its Team or RSVP row (taken after the
 * Event lock, the same order as every team mutation). Without it, two
 * concurrent submits of one DRAFT both see "not yet submitted" and both queue
 * `submission-received`.
 */
export async function lockEntrantRow(tx: Prisma.TransactionClient, auth: EntrantAuth): Promise<void> {
  if (auth.kind === "team-token" || auth.kind === "team-member") {
    await tx.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${auth.teamId} AND "eventId" = ${auth.eventId} FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT "id" FROM "RSVP" WHERE "id" = ${auth.rsvpId} AND "eventId" = ${auth.eventId} FOR UPDATE`;
  }
}

export function entrantWhere(entrant: { eventId: string; teamId: string | null; rsvpId: string | null }): Prisma.SubmissionWhereInput {
  return entrant.teamId ? { eventId: entrant.eventId, teamId: entrant.teamId } : { eventId: entrant.eventId, rsvpId: entrant.rsvpId! };
}
