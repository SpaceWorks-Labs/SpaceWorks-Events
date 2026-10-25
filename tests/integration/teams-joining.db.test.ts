import { EventPrivacyType, RegistrationMode, RsvpStatus, SoloPolicy, TeamJoinRequestStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { teamJoinPath } from "@/lib/teamToken";
import {
  addTeamMemberByLeader,
  createJoinRequest,
  joinTeamWithExistingRsvp,
  loadTeamPage,
  resolveRsvpByTicketToken,
  setLookingForMembers,
} from "@/lib/core/teams";
import {
  createEvent,
  createTeam,
  expectTeamInvariants,
  joinTeam,
  leaderAuth,
  orgSlug,
  organisationId,
  otherOrganisationId,
  registerOk,
  setUpTeams,
  statusOf,
  suffix,
  tearDownTeams,
} from "./helpers/teams";

// Invite-only leader additions, database constraints, and moving an existing registration into a team by its join link.
describe.sequential("team registration integration", () => {
  beforeAll(setUpTeams);

  afterAll(tearDownTeams);

  it("never lets a leader issue guest tickets on an invite-only event", async () => {
    const event = await createEvent({ capacity: 5 });
    const { team } = await createTeam(event, "Invite crew");
    await prisma.event.update({ where: { id: event.id }, data: { privacyType: EventPrivacyType.INVITE_ONLY } });
    const invitedEmail = `invited-${suffix}@example.test`;
    await prisma.eventInvite.create({ data: { eventId: event.id, email: invitedEmail } });
    const before = await prisma.outboxMessage.count({ where: { kind: "team-member-added" } });

    // Being on the invite list is not proof of owning the address.
    const added = await addTeamMemberByLeader(await leaderAuth(team.id), { name: "Claimed Name", email: invitedEmail });
    expect(added).toMatchObject({ ok: false });
    await expect(prisma.rSVP.count({ where: { eventId: event.id, guestEmail: invitedEmail } })).resolves.toBe(0);
    await expect(prisma.outboxMessage.count({ where: { kind: "team-member-added" } })).resolves.toBe(before);
    await expect(loadTeamPage(await leaderAuth(team.id))).resolves.toMatchObject({ event: { inviteOnly: true } });
  });

  it("enforces team settings and join-request rules in the database", async () => {
    const base = {
      organisationId,
      title: `Constraint ${suffix}`,
      startDateTime: new Date("2035-01-01T10:00:00.000Z"),
      endDateTime: new Date("2035-01-01T12:00:00.000Z"),
      timezone: "UTC",
    };
    const invalid = [
      { registrationMode: RegistrationMode.TEAM },
      { registrationMode: RegistrationMode.TEAM, teamMaxSize: 1 },
      { registrationMode: RegistrationMode.TEAM, teamMinSize: 0, teamMaxSize: 3 },
      { registrationMode: RegistrationMode.TEAM, teamMinSize: 4, teamMaxSize: 3 },
    ];
    for (const settings of invalid) {
      await expect(prisma.event.create({ data: { ...base, slug: `constraint-${randomUUID().slice(0, 8)}`, ...settings } })).rejects.toThrow();
    }

    const event = await createEvent({ soloPolicy: SoloPolicy.SOLO_WITH_MATCHING });
    const seeker = await registerOk(event, "seeker");
    await expect(prisma.teamSeekerProfile.create({
      data: { rsvpId: seeker.rsvpId, headline: "Too many skills", skills: Array.from({ length: 9 }, (_, i) => `skill ${i}`) },
    })).rejects.toThrow();

    const { team } = await createTeam(event, "Pending once");
    await prisma.teamJoinRequest.create({ data: { teamId: team.id, rsvpId: seeker.rsvpId, direction: "INVITE" } });
    await expect(prisma.teamJoinRequest.create({ data: { teamId: team.id, rsvpId: seeker.rsvpId, direction: "REQUEST" } })).rejects.toThrow();
    // A closed request does not block a new pending one.
    await prisma.teamJoinRequest.updateMany({ where: { teamId: team.id, rsvpId: seeker.rsvpId }, data: { status: TeamJoinRequestStatus.DECLINED } });
    await expect(prisma.teamJoinRequest.create({ data: { teamId: team.id, rsvpId: seeker.rsvpId, direction: "REQUEST" } })).resolves.toMatchObject({
      status: TeamJoinRequestStatus.PENDING,
    });
  });
  it("moves a solo registration into a team with its join link, freeing and promoting the solo unit", async () => {
    const event = await createEvent({ capacity: 2, soloPolicy: SoloPolicy.SOLO_WITH_MATCHING });
    const { team } = await createTeam(event, "Link joiners");
    const solo = await registerOk(event, "solo", { mode: "solo", seeker: { headline: "Designer", skills: ["Figma"] } });
    const waiting = await registerOk(event, "waiting");
    const waitingTeam = await createTeam(event, "Later team");
    expect([solo.status, waiting.status, waitingTeam.leader.status]).toEqual([RsvpStatus.CONFIRMED, RsvpStatus.WAITLISTED, RsvpStatus.WAITLISTED]);

    // A pending request to another team is cancelled by the move.
    const holder = await resolveRsvpByTicketToken(solo.ticketToken, null);
    if (!holder) throw new Error("solo did not resolve");
    await expect(setLookingForMembers(await leaderAuth(waitingTeam.team.id), true)).resolves.toEqual({ ok: true });
    const request = await createJoinRequest({ direction: "REQUEST", seeker: holder, teamId: waitingTeam.team.id });
    if (!request.ok || !request.data) throw new Error("join request failed");

    const link = `https://events.example${teamJoinPath(orgSlug, event.slug, team.joinToken)}`;
    await expect(joinTeamWithExistingRsvp(holder, link)).resolves.toEqual({
      ok: true,
      data: { status: RsvpStatus.CONFIRMED, teamName: "Link joiners" },
    });
    await expect(prisma.rSVP.findUniqueOrThrow({ where: { id: solo.rsvpId } })).resolves.toMatchObject({
      teamId: team.id,
      status: RsvpStatus.CONFIRMED,
      checkInToken: solo.ticketToken,
    });
    await expect(prisma.teamSeekerProfile.findUniqueOrThrow({ where: { rsvpId: solo.rsvpId } })).resolves.toMatchObject({ visible: false });
    await expect(prisma.teamJoinRequest.findUniqueOrThrow({ where: { id: request.data.requestId } })).resolves.toMatchObject({
      status: TeamJoinRequestStatus.CANCELLED,
    });
    // The solo waiter is the oldest waitlisted unit, so it takes the freed place.
    await expect(statusOf(waiting.rsvpId)).resolves.toBe(RsvpStatus.CONFIRMED);
    await expect(prisma.team.findUniqueOrThrow({ where: { id: waitingTeam.team.id } })).resolves.toMatchObject({ status: RsvpStatus.WAITLISTED });

    // Joining again, or another team, is refused.
    const moved = await resolveRsvpByTicketToken(solo.ticketToken, null);
    if (!moved) throw new Error("moved did not resolve");
    await expect(joinTeamWithExistingRsvp(moved, team.joinToken)).resolves.toEqual({ ok: false, error: "You're already in this team." });
    await expect(joinTeamWithExistingRsvp(moved, waitingTeam.team.joinToken)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/already in a team/) });
    await expectTeamInvariants(event);
  });

  it("refuses join links from another event, full teams, and checked-in moves into a team without a place", async () => {
    const event = await createEvent({ capacity: 2, teamMaxSize: 2 });
    const otherEvent = await createEvent({ capacity: 5 });
    const foreignEvent = await createEvent({ capacity: 5, organisation: otherOrganisationId });
    const { team: full } = await createTeam(event, "Full pair");
    await joinTeam(event, full.id);
    const solo = await registerOk(event, "solo");
    const { team: waitingTeam } = await createTeam(event, "No place yet");
    const { team: otherTeam } = await createTeam(otherEvent, "Elsewhere");
    const { team: foreignTeam } = await createTeam(foreignEvent, "Foreign");
    const holder = await resolveRsvpByTicketToken(solo.ticketToken, null);
    if (!holder) throw new Error("solo did not resolve");

    for (const token of [otherTeam.joinToken, foreignTeam.joinToken]) {
      await expect(joinTeamWithExistingRsvp(holder, token)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/no longer valid/) });
    }
    await expect(joinTeamWithExistingRsvp(holder, `https://events.example/team/${full.joinToken}`)).resolves.toMatchObject({ ok: false });
    await expect(joinTeamWithExistingRsvp(holder, full.joinToken)).resolves.toEqual({ ok: false, error: "This team is already full." });

    await prisma.rSVP.update({ where: { id: solo.rsvpId }, data: { checkedInAt: new Date() } });
    await expect(joinTeamWithExistingRsvp(holder, waitingTeam.joinToken)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/already checked in/),
    });
    await expect(prisma.rSVP.findUniqueOrThrow({ where: { id: solo.rsvpId } })).resolves.toMatchObject({ teamId: null, status: RsvpStatus.CONFIRMED });
    // A holder from another event can't use this event's links either.
    const outsider = await registerOk(otherEvent, "outsider");
    const outsiderHolder = await resolveRsvpByTicketToken(outsider.ticketToken, null);
    if (!outsiderHolder) throw new Error("outsider did not resolve");
    await expect(joinTeamWithExistingRsvp(outsiderHolder, waitingTeam.joinToken)).resolves.toMatchObject({ ok: false });
    // A withdrawn event page resolves no join link, like the join page's 404.
    await prisma.rSVP.update({ where: { id: solo.rsvpId }, data: { checkedInAt: null } });
    await prisma.eventPage.update({ where: { eventId: event.id }, data: { isPublished: false } });
    await expect(joinTeamWithExistingRsvp(holder, waitingTeam.joinToken)).resolves.toEqual({
      ok: false,
      error: "This event is no longer taking team changes.",
    });
    await prisma.eventPage.update({ where: { eventId: event.id }, data: { isPublished: true } });
    await expectTeamInvariants(event);
    await expectTeamInvariants(otherEvent);
  });
});
