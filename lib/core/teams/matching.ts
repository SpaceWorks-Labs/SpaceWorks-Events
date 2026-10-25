import "server-only";

import {
  EventStatus,
  Prisma,
  RegistrationMode,
  RsvpStatus,
  TeamJoinRequestDirection,
  TeamJoinRequestStatus,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { flattenZodErrors } from "@/app/actions/utils";
import { enqueueRsvpStatusNotification } from "@/lib/outbox";
import { retireSoloSubmissionForTeamTx } from "@/lib/core/submissionLifecycle";
import { promoteOldestWaitlistedUnit } from "@/lib/teamUnits";
import type { WebhookEmission } from "@/lib/webhooks/emit";
import { joinTokenFromInput } from "@/lib/teamToken";
import { upsertSeekerProfileSchema } from "@/lib/validators";
import {
  fail,
  hasFreeSpace,
  isMatchingEvent,
  isUniqueViolation,
  lockedLeaderTeam,
  lockEvent,
  NOT_A_TEAM_EVENT,
  personEmail,
  TEAM_NOT_FOUND,
  teamTransaction,
  type JoinRequestActor,
  type LockedEvent,
  type TeamLeaderAuth,
  type TeamResult,
  type TicketHolder,
} from "./shared";

// ---------------------------------------------------------------------------
// Looking for a team (SOLO_WITH_MATCHING)
// ---------------------------------------------------------------------------

/** Create or edit (or hide, with `visible: false`) the holder's seeker profile. */
export async function upsertSeekerProfile(holder: TicketHolder, input: unknown): Promise<TeamResult> {
  const parsed = upsertSeekerProfileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input.", fieldErrors: flattenZodErrors(parsed.error) };
  return prisma.$transaction(async (tx): Promise<TeamResult> => {
    const event = await lockEvent(tx, holder.eventId);
    if (!event || !isMatchingEvent(event)) return fail("This event doesn't have a Looking for a team list.");
    const rsvp = await tx.rSVP.findFirst({ where: { id: holder.rsvpId, eventId: event.id }, select: { id: true, teamId: true, status: true } });
    if (!rsvp) return fail("Registration not found.");
    if (rsvp.teamId) return fail("You're already in a team.");
    if (rsvp.status === RsvpStatus.REJECTED) return fail("This registration was declined.");
    const data = { headline: parsed.data.headline, skills: parsed.data.skills, visible: parsed.data.visible };
    await tx.teamSeekerProfile.upsert({ where: { rsvpId: rsvp.id }, create: { rsvpId: rsvp.id, ...data }, update: data });
    return { ok: true };
  });
}

/**
 * INVITE: a leader invites a visible seeker (by seeker profile id).
 * REQUEST: a seeker asks to join a team that is looking for members.
 * At most one pending row per team and registration (partial unique index).
 */
export async function createJoinRequest(
  params:
    | { direction: "INVITE"; leader: TeamLeaderAuth; seekerProfileId: string }
    | { direction: "REQUEST"; seeker: TicketHolder; teamId: string },
): Promise<TeamResult<{ requestId: string }>> {
  const eventId = params.direction === "INVITE" ? params.leader.eventId : params.seeker.eventId;
  try {
    return await prisma.$transaction(async (tx): Promise<TeamResult<{ requestId: string }>> => {
      const event = await lockEvent(tx, eventId);
      if (!event || !isMatchingEvent(event)) return fail("This event doesn't have a Looking for a team list.");
      let teamId: string;
      let rsvpId: string;
      if (params.direction === "INVITE") {
        const team = await lockedLeaderTeam(tx, params.leader);
        if (!team) return fail(TEAM_NOT_FOUND);
        if (team.status === RsvpStatus.REJECTED) return fail("This team can no longer take new members.");
        const profile = await tx.teamSeekerProfile.findFirst({
          where: { id: params.seekerProfileId, visible: true, rsvp: { eventId: event.id, teamId: null, status: { not: RsvpStatus.REJECTED } } },
          select: { rsvpId: true },
        });
        if (!profile) return fail("This person is no longer looking for a team.");
        teamId = team.id;
        rsvpId = profile.rsvpId;
      } else {
        const rsvp = await tx.rSVP.findFirst({
          where: { id: params.seeker.rsvpId, eventId: event.id },
          select: { id: true, teamId: true, status: true, seekerProfile: { select: { visible: true } } },
        });
        if (!rsvp) return fail("Registration not found.");
        if (rsvp.teamId) return fail("You're already in a team.");
        if (rsvp.status === RsvpStatus.REJECTED) return fail("This registration was declined.");
        if (!rsvp.seekerProfile?.visible) return fail("List yourself as looking for a team first.");
        const team = await tx.team.findFirst({
          where: { id: params.teamId, eventId: event.id },
          select: { id: true, status: true, lookingForMembers: true },
        });
        if (!team || !team.lookingForMembers || team.status === RsvpStatus.REJECTED) return fail("This team isn't looking for members.");
        teamId = team.id;
        rsvpId = rsvp.id;
      }
      const size = await tx.rSVP.count({ where: { teamId } });
      if (!hasFreeSpace(event, size)) return fail("This team is already full.");
      const request = await tx.teamJoinRequest.create({
        data: { teamId, rsvpId, direction: params.direction === "INVITE" ? TeamJoinRequestDirection.INVITE : TeamJoinRequestDirection.REQUEST },
        select: { id: true },
      });
      return { ok: true, data: { requestId: request.id } };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("There is already a pending invitation or request between you.");
    console.error("[teams] join request failed");
    return fail("Could not send this request.");
  }
}

/** Load a pending request in the actor's event and check the actor's side. */
async function lockedRequestForActor(
  tx: Prisma.TransactionClient,
  requestId: string,
  eventId: string,
  actor: JoinRequestActor,
  side: "responder" | "creator",
) {
  const request = await tx.teamJoinRequest.findFirst({
    where: { id: requestId, status: TeamJoinRequestStatus.PENDING, team: { eventId }, rsvp: { eventId } },
    select: { id: true, teamId: true, rsvpId: true, direction: true },
  });
  if (!request) return null;
  // INVITE is created by the leader and answered by the seeker; REQUEST the reverse.
  const leaderSide = (request.direction === TeamJoinRequestDirection.INVITE) === (side === "creator");
  if (leaderSide) {
    if (actor.kind !== "leader" || actor.auth.teamId !== request.teamId) return null;
    if (!(await lockedLeaderTeam(tx, actor.auth))) return null;
  } else if (actor.kind !== "seeker" || actor.holder.rsvpId !== request.rsvpId) {
    return null;
  }
  return request;
}

/**
 * Accept or decline a pending invitation/request from the other side.
 * Accepting moves the seeker's RSVP into the team under the event lock: size
 * is rechecked, the RSVP takes the team status, the profile is hidden, other
 * pending requests for that RSVP are cancelled, and a freed solo unit
 * promotes the oldest waitlisted unit.
 */
export async function respondToJoinRequest(params: {
  actor: JoinRequestActor;
  requestId: string;
  accept: boolean;
}): Promise<TeamResult<{ accepted: boolean }>> {
  const eventId = params.actor.kind === "leader" ? params.actor.auth.eventId : params.actor.holder.eventId;
  if (!params.requestId || params.requestId.length > 128) return fail("This request is no longer pending.");
  return teamTransaction(async (tx, webhooks): Promise<TeamResult<{ accepted: boolean }>> => {
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("This request is no longer pending.");
    const request = await lockedRequestForActor(tx, params.requestId, event.id, params.actor, "responder");
    if (!request) return fail("This request is no longer pending.");
    if (!params.accept) {
      await tx.teamJoinRequest.updateMany({ where: { id: request.id, status: TeamJoinRequestStatus.PENDING }, data: { status: TeamJoinRequestStatus.DECLINED } });
      return { ok: true, data: { accepted: false } };
    }
    if (event.registrationMode !== RegistrationMode.TEAM) return fail(NOT_A_TEAM_EVENT);
    const team = await tx.team.findFirst({ where: { id: request.teamId, eventId: event.id }, select: { id: true, name: true, status: true } });
    if (!team || team.status === RsvpStatus.REJECTED) return fail("This team can no longer take new members.");
    const rsvp = await tx.rSVP.findFirst({ where: { id: request.rsvpId, eventId: event.id }, select: soloRsvpSelect });
    if (!rsvp || rsvp.teamId) return fail("This person is already in a team.");
    if (rsvp.status === RsvpStatus.REJECTED) return fail("This registration was declined.");
    const moved = await moveSoloRsvpIntoTeamTx(tx, event, rsvp, team, webhooks, { acceptedRequestId: request.id });
    if (!moved.ok) return moved;
    await tx.teamJoinRequest.update({ where: { id: request.id }, data: { status: TeamJoinRequestStatus.ACCEPTED } });
    return { ok: true, data: { accepted: true } };
  });
}

const soloRsvpSelect = {
  id: true,
  teamId: true,
  status: true,
  checkedInAt: true,
  checkInToken: true,
  guestEmail: true,
  user: { select: { email: true } },
} satisfies Prisma.RSVPSelect;

type SoloRsvpRow = Prisma.RSVPGetPayload<{ select: typeof soloRsvpSelect }>;

/**
 * Inside a transaction that holds the Event lock: move a solo registration
 * into a team of the same event (docs/TEAMS.md). The team size is rechecked,
 * the registration takes the team's status, its seeker profile is hidden, its
 * other pending invitations and requests are cancelled, and when its solo
 * unit was confirmed the freed unit promotes the oldest waitlisted unit. A
 * checked-in person can only join a confirmed team: otherwise their unit
 * would go to the waitlist while they are already inside. Status webhooks
 * (the moved registration's, and any promotion's) go into `webhooks`.
 */
async function moveSoloRsvpIntoTeamTx(
  tx: Prisma.TransactionClient,
  event: LockedEvent,
  rsvp: SoloRsvpRow,
  team: { id: string; name: string; status: RsvpStatus },
  webhooks: WebhookEmission[],
  opts: { acceptedRequestId?: string } = {},
): Promise<TeamResult<{ status: RsvpStatus }>> {
  if (rsvp.teamId) return fail("This registration is already in a team.");
  if (team.status === RsvpStatus.REJECTED) return fail("This team can no longer take new members.");
  if (rsvp.checkedInAt && team.status !== RsvpStatus.CONFIRMED) {
    return fail("This registration has already checked in, so it can only join a team that has a place.");
  }
  const size = await tx.rSVP.count({ where: { teamId: team.id } });
  if (!hasFreeSpace(event, size)) return fail("This team is already full.");
  // An entrant is a team or a single RSVP: the solo project can't come along.
  const retired = await retireSoloSubmissionForTeamTx(tx, { rsvpId: rsvp.id, eventId: event.id, by: "entrant" });
  if (!retired.ok) return fail(retired.error);
  const moved = await tx.rSVP.updateMany({
    where: { id: rsvp.id, eventId: event.id, teamId: null, status: rsvp.status },
    data: { teamId: team.id, status: team.status },
  });
  if (moved.count !== 1) return fail("This registration was changed. Try again.");
  if (rsvp.status !== team.status) {
    webhooks.push({ type: "registration.status_changed", rsvpId: rsvp.id, status: team.status, previousStatus: rsvp.status });
  }
  await tx.teamJoinRequest.updateMany({
    where: {
      rsvpId: rsvp.id,
      status: TeamJoinRequestStatus.PENDING,
      ...(opts.acceptedRequestId ? { id: { not: opts.acceptedRequestId } } : {}),
    },
    data: { status: TeamJoinRequestStatus.CANCELLED },
  });
  await tx.teamSeekerProfile.updateMany({ where: { rsvpId: rsvp.id }, data: { visible: false } });
  if (rsvp.status !== RsvpStatus.CONFIRMED && team.status === RsvpStatus.CONFIRMED) {
    const to = personEmail(rsvp);
    if (to) await enqueueRsvpStatusNotification(tx, { to, eventTitle: event.title, approved: true, checkInToken: rsvp.checkInToken, teamName: team.name });
  }
  // The solo unit is gone; if it was confirmed, a unit is free.
  if (rsvp.status === RsvpStatus.CONFIRMED) webhooks.push(...((await promoteOldestWaitlistedUnit(tx, event))?.webhooks ?? []));
  return { ok: true, data: { status: team.status } };
}

export const JOIN_LINK_INVALID = "This team link is no longer valid. Ask your team leader for a new one.";

/**
 * A solo registrant joins a team with its join link, keeping their existing
 * registration (no second ticket). The holder comes from the ticket token, or
 * from the signed-in owner's own registration on the join page. The team is
 * looked up by its join token inside the holder's event only, so a link for
 * another event never matches. Everything else is `moveSoloRsvpIntoTeamTx`
 * under the Event lock.
 */
export async function joinTeamWithExistingRsvp(
  holder: TicketHolder,
  joinLink: unknown,
): Promise<TeamResult<{ status: RsvpStatus; teamName: string }>> {
  const joinToken = joinTokenFromInput(joinLink);
  if (!joinToken) return fail("Paste the full team link your team leader shared.");
  return teamTransaction(async (tx, webhooks): Promise<TeamResult<{ status: RsvpStatus; teamName: string }>> => {
    const event = await lockEvent(tx, holder.eventId);
    if (!event || event.organisationId !== holder.organisationId) return fail("Registration not found.");
    if (event.registrationMode !== RegistrationMode.TEAM) return fail(NOT_A_TEAM_EVENT);
    // Same gate as the join page: a withdrawn page or a draft event never
    // resolves a join link, so it can't be used to probe team names.
    if (event.status !== EventStatus.PUBLISHED || event.page?.isPublished !== true || event.endDateTime <= new Date()) {
      return fail("This event is no longer taking team changes.");
    }
    const team = await tx.team.findFirst({ where: { joinToken, eventId: event.id }, select: { id: true, name: true, status: true } });
    if (!team || team.status === RsvpStatus.REJECTED) return fail(JOIN_LINK_INVALID);
    const rsvp = await tx.rSVP.findFirst({ where: { id: holder.rsvpId, eventId: event.id }, select: soloRsvpSelect });
    if (!rsvp) return fail("Registration not found.");
    if (rsvp.teamId === team.id) return fail("You're already in this team.");
    if (rsvp.teamId) return fail("You're already in a team. Leave it from your ticket page before joining another.");
    if (rsvp.status === RsvpStatus.REJECTED) return fail("This registration was declined.");
    const moved = await moveSoloRsvpIntoTeamTx(tx, event, rsvp, team, webhooks);
    return moved.ok ? { ok: true, data: { status: team.status, teamName: team.name } } : moved;
  });
}

/** The side that sent a pending invitation/request withdraws it. */
export async function cancelJoinRequest(params: { actor: JoinRequestActor; requestId: string }): Promise<TeamResult> {
  const eventId = params.actor.kind === "leader" ? params.actor.auth.eventId : params.actor.holder.eventId;
  if (!params.requestId || params.requestId.length > 128) return fail("This request is no longer pending.");
  return prisma.$transaction(async (tx): Promise<TeamResult> => {
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("This request is no longer pending.");
    const request = await lockedRequestForActor(tx, params.requestId, event.id, params.actor, "creator");
    if (!request) return fail("This request is no longer pending.");
    await tx.teamJoinRequest.updateMany({ where: { id: request.id, status: TeamJoinRequestStatus.PENDING }, data: { status: TeamJoinRequestStatus.CANCELLED } });
    return { ok: true };
  });
}
