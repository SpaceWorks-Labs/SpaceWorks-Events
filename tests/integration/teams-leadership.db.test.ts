import { RsvpStatus, SoloPolicy, TeamJoinRequestStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { cancelRsvp } from "@/app/actions/rsvp-cancel";
import { countConfirmedUnits } from "@/lib/teamUnits";
import {
  createJoinRequest,
  disbandTeam,
  leaveTeam,
  listSeekersForLeader,
  loadJoinPageTeam,
  loadTeamPage,
  organiserDeleteTeam,
  organiserMoveMember,
  organiserRenameTeam,
  regenerateManageToken,
  removeTeamMember,
  renameTeam,
  resolveOrganiserEvent,
  resolveRsvpByTicketToken,
  resolveTeamByManageToken,
  respondToJoinRequest,
  setLookingForMembers,
  transferLeadership,
  transitionTeamStatus,
  type OrganiserEventContext,
  type TeamLeaderAuth,
} from "@/lib/core/teams";
import {
  actingAs,
  createEvent,
  createTeam,
  currentManageToken,
  expectTeamInvariants,
  joinTeam,
  leaderAuth,
  orgSlug,
  organiser,
  organiserId,
  otherOrganisationId,
  otherOrganiserId,
  otherOrgSlug,
  register,
  registerOk,
  setUpTeams,
  statusOf,
  tearDownTeams,
} from "./helpers/teams";

// Seeker invitations, cross-event and cross-team isolation, management tokens, leadership handover and disbanding.
const as = actingAs(identity);

describe.sequential("team registration integration", () => {
  beforeAll(setUpTeams);

  afterAll(tearDownTeams);

  it("accepting a seeker frees their solo unit and promotes the oldest waitlisted unit", async () => {
    const event = await createEvent({ capacity: 2, soloPolicy: SoloPolicy.SOLO_WITH_MATCHING });
    const teamA = await createTeam(event, "Seekers welcome");
    const seeker = await registerOk(event, "seeker", { mode: "solo", seeker: { headline: "Backend dev", skills: ["Go"] } });
    expect([teamA.leader.status, seeker.status]).toEqual([RsvpStatus.CONFIRMED, RsvpStatus.CONFIRMED]);
    const waiting = await registerOk(event, "waiting");
    const teamB = await createTeam(event, "Waiting team");
    expect([waiting.status, teamB.leader.status]).toEqual([RsvpStatus.WAITLISTED, RsvpStatus.WAITLISTED]);

    const holder = await resolveRsvpByTicketToken(seeker.ticketToken, null);
    if (!holder) throw new Error("seeker did not resolve");
    const authA = await leaderAuth(teamA.team.id);
    const authB = await leaderAuth(teamB.team.id);

    // The seeker also asked to join team B; accepting A's invitation cancels that.
    await expect(setLookingForMembers(authB, true)).resolves.toEqual({ ok: true });
    const request = await createJoinRequest({ direction: "REQUEST", seeker: holder, teamId: teamB.team.id });
    if (!request.ok || !request.data) throw new Error("join request failed");

    const profile = await prisma.teamSeekerProfile.findUniqueOrThrow({ where: { rsvpId: seeker.rsvpId } });
    expect((await listSeekersForLeader(authA))?.items.map((item) => item.id)).toEqual([profile.id]);
    const invite = await createJoinRequest({ direction: "INVITE", leader: authA, seekerProfileId: profile.id });
    if (!invite.ok || !invite.data) throw new Error("invite failed");
    // Once invited, the seeker appears under the team's pending invitations instead.
    await expect(listSeekersForLeader(authA)).resolves.toEqual({ items: [], nextCursor: null, total: 0 });
    // Only the invited side may answer.
    await expect(respondToJoinRequest({ actor: { kind: "leader", auth: authA }, requestId: invite.data.requestId, accept: true })).resolves.toEqual({
      ok: false,
      error: "This request is no longer pending.",
    });

    await expect(respondToJoinRequest({ actor: { kind: "seeker", holder }, requestId: invite.data.requestId, accept: true })).resolves.toEqual({
      ok: true,
      data: { accepted: true },
    });

    await expect(prisma.rSVP.findUniqueOrThrow({ where: { id: seeker.rsvpId } })).resolves.toMatchObject({
      teamId: teamA.team.id,
      status: RsvpStatus.CONFIRMED,
    });
    await expect(prisma.teamSeekerProfile.findUniqueOrThrow({ where: { rsvpId: seeker.rsvpId } })).resolves.toMatchObject({ visible: false });
    await expect(prisma.teamJoinRequest.findUniqueOrThrow({ where: { id: request.data.requestId } })).resolves.toMatchObject({
      status: TeamJoinRequestStatus.CANCELLED,
    });
    // The solo waiter registered before team B, so they are the oldest waitlisted unit.
    await expect(statusOf(waiting.rsvpId)).resolves.toBe(RsvpStatus.CONFIRMED);
    await expect(prisma.team.findUniqueOrThrow({ where: { id: teamB.team.id } })).resolves.toMatchObject({ status: RsvpStatus.WAITLISTED });
    await expect(prisma.$transaction((tx) => countConfirmedUnits(tx, event.id))).resolves.toBe(2);
    await expectTeamInvariants(event);
  });

  it("refuses team ids from another event or organisation", async () => {
    const event = await createEvent({ capacity: 10 });
    const otherEvent = await createEvent({ capacity: 10 });
    const foreignEvent = await createEvent({ capacity: 10, organisation: otherOrganisationId });
    const ctx = await organiser(event);
    const local = await createTeam(event, "Home team");
    const elsewhere = await createTeam(otherEvent, "Other event team");
    const elsewhereMember = await joinTeam(otherEvent, elsewhere.team.id);
    const foreign = await createTeam(foreignEvent, "Foreign team");
    const solo = await registerOk(event, "solo");

    // Organiser access is resolved inside the organisation.
    await expect(resolveOrganiserEvent(organiserId, orgSlug, foreignEvent.id)).resolves.toBeNull();
    await expect(resolveOrganiserEvent(organiserId, otherOrgSlug, foreignEvent.id)).resolves.toBeNull();
    await expect(resolveOrganiserEvent(otherOrganiserId, orgSlug, event.id)).resolves.toBeNull();
    const forged: OrganiserEventContext = { ...ctx, eventId: foreignEvent.id };
    await expect(transitionTeamStatus(forged, foreign.team.id, "reject")).resolves.toEqual({ ok: false, error: "Event not found." });

    for (const teamId of [elsewhere.team.id, foreign.team.id]) {
      await expect(transitionTeamStatus(ctx, teamId, "reject")).resolves.toEqual({ ok: false, error: "Team not found." });
      await expect(organiserRenameTeam(ctx, teamId, "Stolen")).resolves.toEqual({ ok: false, error: "Team not found." });
      await expect(organiserDeleteTeam(ctx, teamId)).resolves.toEqual({ ok: false, error: "Team not found." });
      await expect(organiserMoveMember(ctx, { rsvpId: solo.rsvpId, targetTeamId: teamId })).resolves.toEqual({ ok: false, error: "Team not found." });
    }
    await expect(organiserMoveMember(ctx, { rsvpId: elsewhereMember.rsvpId, targetTeamId: local.team.id })).resolves.toEqual({
      ok: false,
      error: "RSVP not found.",
    });

    // A join token only works on its own event.
    const { result } = await register(event, "crosser", { mode: "join", joinToken: elsewhere.team.joinToken });
    expect(result).toEqual({ ok: false, error: "This team link is no longer valid. Ask your team leader for a new one." });
    await expect(loadJoinPageTeam(event.id, elsewhere.team.joinToken)).resolves.toBeNull();

    // Leader authority from one event cannot be pointed at a team elsewhere.
    const localAuth = await leaderAuth(local.team.id);
    const crossAuth: TeamLeaderAuth = { ...localAuth, teamId: elsewhere.team.id };
    await expect(renameTeam(crossAuth, { name: "Hijacked" })).resolves.toEqual({ ok: false, error: "Team not found." });
    await expect(removeTeamMember(localAuth, elsewhereMember.rsvpId)).resolves.toEqual({ ok: false, error: "Member not found." });

    await expect(prisma.team.findUniqueOrThrow({ where: { id: elsewhere.team.id } })).resolves.toMatchObject({ name: "Other event team", status: RsvpStatus.CONFIRMED });
    await expect(prisma.team.findUniqueOrThrow({ where: { id: foreign.team.id } })).resolves.toMatchObject({ name: "Foreign team", status: RsvpStatus.CONFIRMED });
    for (const checked of [event, otherEvent, foreignEvent]) await expectTeamInvariants(checked);
  });

  it("does not let one team's management token act on another team", async () => {
    const event = await createEvent({ capacity: 10 });
    const teamA = await createTeam(event, "Token A");
    const teamB = await createTeam(event, "Token B");
    const memberB = await joinTeam(event, teamB.team.id);

    const authA = await resolveTeamByManageToken(teamA.manageToken);
    expect(authA).toMatchObject({ kind: "token", teamId: teamA.team.id, eventId: event.id });
    const forged: TeamLeaderAuth = { ...authA!, teamId: teamB.team.id };

    await expect(renameTeam(forged, { name: "Taken over" })).resolves.toEqual({ ok: false, error: "Team not found." });
    await expect(removeTeamMember(forged, memberB.rsvpId)).resolves.toEqual({ ok: false, error: "Team not found." });
    await expect(removeTeamMember(authA!, memberB.rsvpId)).resolves.toEqual({ ok: false, error: "Member not found." });
    await expect(transferLeadership(authA!, memberB.rsvpId)).resolves.toEqual({ ok: false, error: "Member not found." });
    await expect(disbandTeam(forged)).resolves.toEqual({ ok: false, error: "Team not found." });
    await expect(regenerateManageToken(forged)).resolves.toEqual({ ok: false, error: "Team not found." });
    await expect(loadTeamPage(forged)).resolves.toBeNull();
    // The check-in token never grants team management.
    await expect(resolveTeamByManageToken(teamB.leader.ticketToken)).resolves.toBeNull();

    await expect(prisma.team.findUniqueOrThrow({ where: { id: teamB.team.id } })).resolves.toMatchObject({ name: "Token B" });
    await expect(prisma.rSVP.count({ where: { teamId: teamB.team.id } })).resolves.toBe(2);

    // Regenerating retires the old link immediately.
    const rotated = await regenerateManageToken(authA!);
    expect(rotated.ok).toBe(true);
    await expect(resolveTeamByManageToken(teamA.manageToken)).resolves.toBeNull();
    await expect(renameTeam(authA!, { name: "Stale" })).resolves.toEqual({ ok: false, error: "Team not found." });
    await expect(resolveTeamByManageToken(rotated.ok ? rotated.data!.manageToken : "")).resolves.toMatchObject({ teamId: teamA.team.id });
    // The new link is emailed to the leader, so losing the tab never strands the team.
    const leaderA = await prisma.rSVP.findUniqueOrThrow({ where: { id: teamA.team.leaderRsvpId! }, select: { guestEmail: true } });
    const resetMail = await prisma.outboxMessage.findMany({ where: { kind: "team-created", AND: [{ payload: { path: ["teamId"], equals: teamA.team.id } }, { payload: { path: ["reason"], equals: "reset" } }] } });
    expect(resetMail.map((message) => message.payload)).toEqual([
      { to: leaderA.guestEmail, teamId: teamA.team.id, manageToken: rotated.ok ? rotated.data!.manageToken : "", reason: "reset" },
    ]);
    await expectTeamInvariants(event);
  });

  it("passes leadership on when the leader cancels, and frees the unit when the last member leaves", async () => {
    const event = await createEvent({ capacity: 1 });
    const { leader, team, manageToken } = await createTeam(event, "Handover");
    const first = await joinTeam(event, team.id, "first");
    const second = await joinTeam(event, team.id, "second");
    const waiting = await registerOk(event, "waiting");
    expect(waiting.status).toBe(RsvpStatus.WAITLISTED);

    await expect(as("", () => cancelRsvp({ checkInToken: leader.ticketToken }))).resolves.toEqual({ ok: true, data: { cancelled: true } });
    const afterLeader = await prisma.team.findUniqueOrThrow({ where: { id: team.id } });
    expect(afterLeader.leaderRsvpId).toBe(first.rsvpId);
    expect(afterLeader.manageTokenHash).not.toBe(team.manageTokenHash);
    await expect(resolveTeamByManageToken(manageToken)).resolves.toBeNull();
    const handover = await prisma.outboxMessage.findMany({ where: { kind: "team-created", payload: { path: ["teamId"], equals: team.id } } });
    expect(handover.map((message) => message.payload)).toContainEqual(expect.objectContaining({ to: first.email, reason: "leader" }));
    await expect(resolveTeamByManageToken(await currentManageToken(team.id))).resolves.toMatchObject({ teamId: team.id });
    // The team is still a confirmed unit, so nobody is promoted.
    await expect(statusOf(waiting.rsvpId)).resolves.toBe(RsvpStatus.WAITLISTED);
    await expectTeamInvariants(event);

    await expect(leaveTeam(null, second.ticketToken)).resolves.toEqual({ ok: true, data: { cancelled: true } });
    await expect(prisma.team.findUniqueOrThrow({ where: { id: team.id } })).resolves.toMatchObject({ leaderRsvpId: first.rsvpId });
    await expectTeamInvariants(event);

    await expect(leaveTeam(null, first.ticketToken)).resolves.toEqual({ ok: true, data: { cancelled: true } });
    await expect(prisma.team.findUnique({ where: { id: team.id } })).resolves.toBeNull();
    await expect(statusOf(waiting.rsvpId)).resolves.toBe(RsvpStatus.CONFIRMED);
    await expectTeamInvariants(event);
  });

  it("disbanding frees the unit and promotes the oldest waitlisted unit", async () => {
    const event = await createEvent({ capacity: 1 });
    const confirmed = await createTeam(event, "Disbanders");
    await joinTeam(event, confirmed.team.id);
    const waitingTeam = await createTeam(event, "First in line");
    const waitingMember = await joinTeam(event, waitingTeam.team.id);
    const waitingSolo = await registerOk(event, "later");
    expect([waitingTeam.leader.status, waitingMember.status, waitingSolo.status]).toEqual([
      RsvpStatus.WAITLISTED,
      RsvpStatus.WAITLISTED,
      RsvpStatus.WAITLISTED,
    ]);

    await expect(disbandTeam(await leaderAuth(confirmed.team.id))).resolves.toEqual({ ok: true, data: { cancelled: 2 } });
    await expect(prisma.team.findUnique({ where: { id: confirmed.team.id } })).resolves.toBeNull();
    await expect(prisma.rSVP.count({ where: { id: confirmed.leader.rsvpId } })).resolves.toBe(0);

    // The waitlisted team is older than the solo waiter: the whole team is promoted together.
    await expect(prisma.team.findUniqueOrThrow({ where: { id: waitingTeam.team.id } })).resolves.toMatchObject({ status: RsvpStatus.CONFIRMED });
    await expect(statusOf(waitingMember.rsvpId)).resolves.toBe(RsvpStatus.CONFIRMED);
    await expect(statusOf(waitingSolo.rsvpId)).resolves.toBe(RsvpStatus.WAITLISTED);
    await expectTeamInvariants(event);
  });
});
