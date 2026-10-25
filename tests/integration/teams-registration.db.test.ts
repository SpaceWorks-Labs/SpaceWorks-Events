import { EventPrivacyType, RegistrationMode, RsvpStatus, SoloPolicy } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { cancelRsvp } from "@/app/actions/rsvp-cancel";
import { approveRsvp } from "@/app/actions/rsvp-lifecycle";
import { countConfirmedUnits } from "@/lib/teamUnits";
import {
  addTeamMemberByLeader,
  disbandTeam,
  loadJoinPageTeam,
  regenerateJoinToken,
  regenerateManageToken,
  removeTeamMember,
  renameTeam,
  resolveTeamByManageToken,
  setLookingForMembers,
  transferLeadership,
  transitionTeamStatus,
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
  register,
  registerOk,
  setUpTeams,
  statusOf,
  suffix,
  tearDownTeams,
} from "./helpers/teams";

// Registration modes, team size and capacity races, whole-team approval, and rejected teams.
const as = actingAs(identity);

describe.sequential("team registration integration", () => {
  beforeAll(setUpTeams);

  afterAll(tearDownTeams);

  it("leaves INDIVIDUAL events unchanged", async () => {
    const event = await createEvent({ registrationMode: RegistrationMode.INDIVIDUAL, capacity: 1 });
    const first = await registerOk(event, "individual");
    const second = await registerOk(event, "individual");
    expect([first.status, second.status]).toEqual([RsvpStatus.CONFIRMED, RsvpStatus.WAITLISTED]);
    expect([first.teamId, second.teamId]).toEqual([null, null]);

    const { result } = await register(event, "individual", { mode: "create", name: "Not here" });
    expect(result).toEqual({ ok: false, error: "This event does not use team registration." });
    await expect(prisma.team.count({ where: { eventId: event.id } })).resolves.toBe(0);

    await expect(as("", () => cancelRsvp({ checkInToken: first.ticketToken }))).resolves.toEqual({ ok: true, data: { cancelled: true } });
    await expect(statusOf(second.rsvpId)).resolves.toBe(RsvpStatus.CONFIRMED);
  });

  it("refuses solo registration on a TEAMS_ONLY event with TEAM_REQUIRED", async () => {
    const event = await createEvent({ soloPolicy: SoloPolicy.TEAMS_ONLY });
    const { result } = await register(event, "solo");
    expect(result).toMatchObject({ ok: false, code: "TEAM_REQUIRED" });
    await expect(prisma.rSVP.count({ where: { eventId: event.id } })).resolves.toBe(0);
  });

  it("keeps team names unique per event, ignoring case and spacing", async () => {
    const event = await createEvent();
    await createTeam(event, "Pixel  Pirates");
    const { result } = await register(event, "dupe", { mode: "create", name: "pixel pirates" });
    expect(result).toEqual({ ok: false, error: "That team name is already taken for this event." });
    await expectTeamInvariants(event);
  });

  it("never oversells the last unit when teams are created concurrently", async () => {
    const event = await createEvent({ capacity: 2 });
    const solo = await registerOk(event, "solo");
    expect(solo.status).toBe(RsvpStatus.CONFIRMED);

    const results = await Promise.all(
      ["Alpha", "Bravo", "Charlie", "Delta"].map((name) => register(event, "racer", { mode: "create", name })),
    );
    expect(results.every(({ result }) => result.ok)).toBe(true);
    const statuses = results.map(({ result }) => (result.ok ? result.data!.status : null));
    expect(statuses.filter((status) => status === RsvpStatus.CONFIRMED)).toHaveLength(1);
    expect(statuses.filter((status) => status === RsvpStatus.WAITLISTED)).toHaveLength(3);
    await expect(prisma.$transaction((tx) => countConfirmedUnits(tx, event.id))).resolves.toBe(2);
    await expect(prisma.team.count({ where: { eventId: event.id, status: RsvpStatus.CONFIRMED } })).resolves.toBe(1);
    await expectTeamInvariants(event);
  });

  it("never exceeds teamMaxSize when people join concurrently", async () => {
    const event = await createEvent({ capacity: 10, teamMaxSize: 3 });
    const { team } = await createTeam(event, "Joiners");

    const results = await Promise.all(
      Array.from({ length: 5 }, () => register(event, "joiner", { mode: "join", joinToken: team.joinToken })),
    );
    expect(results.filter(({ result }) => result.ok)).toHaveLength(2);
    for (const { result } of results.filter(({ result }) => !result.ok)) {
      expect(result).toEqual({ ok: false, error: "This team is already full." });
    }
    await expect(prisma.rSVP.count({ where: { teamId: team.id } })).resolves.toBe(3);
    // Joining never consumes a unit.
    await expect(prisma.$transaction((tx) => countConfirmedUnits(tx, event.id))).resolves.toBe(1);
    await expectTeamInvariants(event);
  });

  it("approves a whole team atomically and refuses approval below the minimum size", async () => {
    const event = await createEvent({ privacyType: EventPrivacyType.APPROVAL_REQUIRED, capacity: 5, teamMinSize: 3, teamMaxSize: 4 });
    const ctx = await organiser(event);
    const { leader, team } = await createTeam(event, "Approvers");
    expect(leader.status).toBe(RsvpStatus.PENDING_APPROVAL);

    const member = await joinTeam(event, team.id);
    expect(member.status).toBe(RsvpStatus.PENDING_APPROVAL);
    await expect(transitionTeamStatus(ctx, team.id, "approve")).resolves.toEqual({
      ok: false,
      error: "This team is incomplete (2 of at least 3 members), so it can't be approved yet.",
    });
    await expectTeamInvariants(event);

    // Individual approval of a team member is refused.
    await expect(as(organiserId, () => approveRsvp({ organisationSlug: orgSlug, eventId: event.id, rsvpId: member.rsvpId }))).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("belongs to a team"),
    });

    const third = await joinTeam(event, team.id);
    const before = new Date();
    const outcomes = await Promise.all([
      transitionTeamStatus(ctx, team.id, "approve"),
      transitionTeamStatus(ctx, team.id, "approve"),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({ ok: false });

    await expect(prisma.team.findUniqueOrThrow({ where: { id: team.id } })).resolves.toMatchObject({ status: RsvpStatus.CONFIRMED });
    const members = await prisma.rSVP.findMany({ where: { teamId: team.id } });
    expect(members.map((rsvp) => rsvp.status)).toEqual([RsvpStatus.CONFIRMED, RsvpStatus.CONFIRMED, RsvpStatus.CONFIRMED]);
    await expectTeamInvariants(event);

    const messages = await prisma.outboxMessage.findMany({ where: { kind: "rsvp-status", createdAt: { gte: before } } });
    const forTeam = messages.filter((message) => (message.payload as { teamName?: string }).teamName === "Approvers");
    expect(forTeam.map((message) => (message.payload as { to: string }).to).sort()).toEqual(
      [leader.email, member.email, third.email].sort(),
    );
  });

  it("refuses joins and leader additions for a rejected team", async () => {
    const event = await createEvent({ privacyType: EventPrivacyType.APPROVAL_REQUIRED });
    const ctx = await organiser(event);
    const { team } = await createTeam(event, "Declined");
    await joinTeam(event, team.id);
    const auth = await leaderAuth(team.id);

    await expect(transitionTeamStatus(ctx, team.id, "reject")).resolves.toEqual({ ok: true, data: { status: RsvpStatus.REJECTED } });
    await expectTeamInvariants(event);

    const { result } = await register(event, "late", { mode: "join", joinToken: team.joinToken });
    expect(result).toEqual({ ok: false, error: "This team can no longer be joined." });
    await expect(loadJoinPageTeam(event.id, team.joinToken)).resolves.toBeNull();
    await expect(addTeamMemberByLeader(auth, { name: "Added Later", email: `added-${suffix}@example.test` })).resolves.toEqual({
      ok: false,
      error: "This team can no longer take new members.",
    });
    await expect(prisma.rSVP.count({ where: { teamId: team.id } })).resolves.toBe(2);
    await expectTeamInvariants(event);
  });

  it("refuses rename, link resets, leadership transfer and matching for a declined team, but still allows removal and disbanding", async () => {
    const event = await createEvent({ privacyType: EventPrivacyType.APPROVAL_REQUIRED, soloPolicy: SoloPolicy.SOLO_WITH_MATCHING });
    const ctx = await organiser(event);
    const { team } = await createTeam(event, "Turned Down");
    const second = await joinTeam(event, team.id, "second");
    const third = await joinTeam(event, team.id, "third");
    const auth = await leaderAuth(team.id);
    await expect(transitionTeamStatus(ctx, team.id, "reject")).resolves.toEqual({ ok: true, data: { status: RsvpStatus.REJECTED } });
    const before = await prisma.team.findUniqueOrThrow({ where: { id: team.id } });

    const declined = { ok: false, error: "The organisers declined this team, so it can't be changed. You can still remove members or disband it." };
    await expect(renameTeam(auth, { name: "Renamed Anyway" })).resolves.toEqual(declined);
    await expect(regenerateJoinToken(auth)).resolves.toEqual(declined);
    await expect(regenerateManageToken(auth)).resolves.toEqual(declined);
    await expect(transferLeadership(auth, second.rsvpId)).resolves.toEqual(declined);
    await expect(setLookingForMembers(auth, true)).resolves.toEqual(declined);
    const after = await prisma.team.findUniqueOrThrow({ where: { id: team.id } });
    expect({ name: after.name, joinToken: after.joinToken, manageTokenHash: after.manageTokenHash, leaderRsvpId: after.leaderRsvpId, lookingForMembers: after.lookingForMembers })
      .toEqual({ name: before.name, joinToken: before.joinToken, manageTokenHash: before.manageTokenHash, leaderRsvpId: before.leaderRsvpId, lookingForMembers: before.lookingForMembers });
    // The old management link still resolves: nothing was rotated.
    await expect(resolveTeamByManageToken(await currentManageToken(team.id))).resolves.not.toBeNull();
    await expectTeamInvariants(event);

    // Removing a member and disbanding (cancelling) stay available.
    await expect(removeTeamMember(auth, third.rsvpId)).resolves.toEqual({ ok: true });
    await expect(disbandTeam(auth)).resolves.toEqual({ ok: true, data: { cancelled: 2 } });
    await expect(prisma.team.count({ where: { id: team.id } })).resolves.toBe(0);
  });
});
