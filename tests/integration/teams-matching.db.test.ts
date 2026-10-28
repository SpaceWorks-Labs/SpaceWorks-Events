import { RsvpStatus, SoloPolicy, TeamJoinRequestDirection, TeamJoinRequestStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import {
  createJoinRequest,
  listSeekerInvites,
  listSeekerRequests,
  listSeekersForLeader,
  listSeekersForSeeker,
  listTeamJoinRequestsForLeader,
  listTeamsLookingForMembers,
  loadSeekerView,
  loadTeamPage,
  respondToJoinRequest,
  setLookingForMembers,
  type TeamLeaderAuth,
} from "@/lib/core/teams";
import {
  createEvent,
  createTeam,
  joinTeam,
  leaderAuth,
  registerOk,
  seekerHolder,
  setUpTeams,
  tearDownTeams,
  walkPages,
  type Registered,
} from "./helpers/teams";

// Seeker and team matching lists, paged by keyset.
describe.sequential("team registration integration", () => {
  beforeAll(setUpTeams);

  afterAll(tearDownTeams);

  it("pages the leader's seeker list by keyset, with search, scoping and a separate total", { timeout: 120_000 }, async () => {
    const event = await createEvent({ soloPolicy: SoloPolicy.SOLO_WITH_MATCHING, teamMaxSize: 4 });
    const other = await createEvent({ soloPolicy: SoloPolicy.SOLO_WITH_MATCHING, teamMaxSize: 4 });
    const { team } = await createTeam(event, "Paging leaders");
    const auth = await leaderAuth(team.id);
    const seekers: Registered[] = [];
    for (let n = 0; n < 45; n += 1) {
      const skills = n % 9 === 0 ? ["Rustacean", "Go"] : ["Figma"];
      seekers.push(await registerOk(event, `seek${n}`, { mode: "solo", seeker: { headline: `Seeker number ${n}`, skills } }));
    }
    // Another event's seeker never shows up.
    await registerOk(other, "elsewhere", { mode: "solo", seeker: { headline: "Rustacean elsewhere", skills: ["Rustacean"] } });
    const profiles = await prisma.teamSeekerProfile.findMany({ where: { rsvp: { eventId: event.id } }, select: { id: true, rsvpId: true } });
    expect(profiles).toHaveLength(45);
    // Ties on updatedAt across a page boundary must neither repeat nor skip anyone.
    const tied = profiles.slice(10, 40).map((profile) => profile.id);
    await prisma.$executeRaw`UPDATE "TeamSeekerProfile" SET "updatedAt" = '2035-01-01 00:00:00' WHERE "id" = ANY(${tied})`;

    const walked = await walkPages((cursor) => listSeekersForLeader(auth, { cursor }));
    expect(walked.pages).toBe(3);
    expect(walked.totals).toEqual([45]);
    expect(walked.items.map((item) => item.id).sort()).toEqual(profiles.map((profile) => profile.id).sort());
    const expectedOrder = await prisma.teamSeekerProfile.findMany({
      where: { rsvp: { eventId: event.id } },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      select: { id: true },
    });
    expect(walked.items.map((item) => item.id)).toEqual(expectedOrder.map((row) => row.id));
    expect(JSON.stringify(walked.items)).not.toContain("example.test");

    // Skill search is case-insensitive and partial; the total follows the search.
    const rust = await walkPages((cursor) => listSeekersForLeader(auth, { query: "rust", cursor }));
    expect(rust.totals).toEqual([5]);
    expect(rust.items).toHaveLength(5);
    // First name matches; a surname ("Person") never does.
    await expect(listSeekersForLeader(auth, { query: "seek12" })).resolves.toMatchObject({ total: 1, items: [{ displayName: "seek12 P." }] });
    await expect(listSeekersForLeader(auth, { query: "Person" })).resolves.toEqual({ items: [], nextCursor: null, total: 0 });
    // Headline search.
    await expect(listSeekersForLeader(auth, { query: "number 44" })).resolves.toMatchObject({ total: 1 });

    // An invited seeker moves to the team's pending invitations and leaves the list and its count.
    const invite = await createJoinRequest({ direction: "INVITE", leader: auth, seekerProfileId: walked.items[0]!.id });
    expect(invite.ok).toBe(true);
    const afterInvite = await listSeekersForLeader(auth);
    expect(afterInvite?.total).toBe(44);
    expect(afterInvite?.items.map((item) => item.id)).not.toContain(walked.items[0]!.id);

    // Every page re-checks the leader and the list's own rules.
    await expect(listSeekersForLeader({ ...auth, manageTokenHash: "0".repeat(64) } as TeamLeaderAuth, { cursor: null })).resolves.toBeNull();
    await expect(listSeekersForLeader(auth, { cursor: "not-a-cursor" })).resolves.toEqual({ items: [], nextCursor: null, total: 0 });
    await expect(listSeekersForLeader(auth, { eventId: other.id })).resolves.toEqual({ items: [], nextCursor: null, total: 0 });
    for (let n = 0; n < 3; n += 1) await joinTeam(event, team.id, `filler${n}`);
    await expect(listSeekersForLeader(auth, { cursor: walked.items[5]!.id })).resolves.toBeNull();

    // Seekers see everyone else, never themselves.
    const holder = await seekerHolder(seekers[1]!.ticketToken);
    const others = await walkPages((cursor) => listSeekersForSeeker(holder, { cursor }));
    expect(others.totals).toEqual([44]);
    const own = await prisma.teamSeekerProfile.findUniqueOrThrow({ where: { rsvpId: seekers[1]!.rsvpId } });
    expect(others.items.map((item) => item.id)).not.toContain(own.id);
  });

  it("pages teams looking for members with the free-space test before the limit", { timeout: 120_000 }, async () => {
    const event = await createEvent({ soloPolicy: SoloPolicy.SOLO_WITH_MATCHING, teamMaxSize: 2 });
    // The oldest teams are full: they must not take places on the first page.
    for (let n = 0; n < 3; n += 1) {
      const full = await createTeam(event, `Full ${n}`);
      await setLookingForMembers(await leaderAuth(full.team.id), true);
      await joinTeam(event, full.team.id, `full${n}`);
    }
    const declined = await createTeam(event, "Declined open");
    await setLookingForMembers(await leaderAuth(declined.team.id), true);
    await prisma.team.update({ where: { id: declined.team.id }, data: { status: RsvpStatus.REJECTED } });
    await createTeam(event, "Not looking");
    const open: Array<{ id: string; auth: TeamLeaderAuth }> = [];
    for (let n = 0; n < 22; n += 1) {
      const created = await createTeam(event, n === 7 ? "Owl Squad" : `Open ${n}`);
      const auth = await leaderAuth(created.team.id);
      await setLookingForMembers(auth, true);
      open.push({ id: created.team.id, auth });
    }
    const seeker = await registerOk(event, "lfg", { mode: "solo", seeker: { headline: "Anything", skills: [] } });
    const requester = await registerOk(event, "asker", { mode: "solo", seeker: { headline: "Asking", skills: [] } });
    const holder = await seekerHolder(seeker.ticketToken);
    const asker = await seekerHolder(requester.ticketToken);

    const walked = await walkPages((cursor) => listTeamsLookingForMembers(holder, { cursor }));
    expect(walked.pages).toBe(2);
    expect(walked.totals).toEqual([22]);
    expect(walked.items.map((team) => team.id)).toEqual(open.map((team) => team.id));
    expect(walked.items.every((team) => team.size < 2 && team.maxSize === 2 && !team.requested)).toBe(true);
    await expect(listTeamsLookingForMembers(holder, { query: "owl" })).resolves.toMatchObject({ total: 1, items: [{ name: "Owl Squad" }] });

    // The seeker's own pending request is flagged on the team.
    expect((await createJoinRequest({ direction: "REQUEST", seeker: holder, teamId: open[0]!.id })).ok).toBe(true);
    expect((await listTeamsLookingForMembers(holder))?.items[0]).toMatchObject({ id: open[0]!.id, requested: true });
    expect((await listTeamsLookingForMembers(asker))?.items[0]).toMatchObject({ id: open[0]!.id, requested: false });

    // Invitations and requests on the ticket page: first 20 with a total, then "Show more".
    const askerProfile = await prisma.teamSeekerProfile.findUniqueOrThrow({ where: { rsvpId: requester.rsvpId } });
    for (const team of open.slice(0, 21)) {
      expect((await createJoinRequest({ direction: "INVITE", leader: team.auth, seekerProfileId: askerProfile.id })).ok).toBe(true);
    }
    for (const team of open.slice(1, 22)) {
      expect((await createJoinRequest({ direction: "REQUEST", seeker: holder, teamId: team.id })).ok).toBe(true);
    }
    const askerView = await loadSeekerView(asker);
    expect(askerView?.invites).toMatchObject({ total: 21 });
    expect(askerView?.invites.items).toHaveLength(20);
    expect(askerView?.requests).toEqual({ items: [], nextCursor: null, total: 0 });
    const invites = await walkPages((cursor) => listSeekerInvites(asker, { cursor }));
    expect(invites.totals).toEqual([21]);
    expect(new Set(invites.items.map((item) => item.id)).size).toBe(21);
    expect(JSON.stringify(invites.items)).not.toMatch(/example\.test|Person/);
    const requests = await walkPages((cursor) => listSeekerRequests(holder, { cursor }));
    expect(requests.totals).toEqual([22]);
    expect(requests.items.map((item) => item.teamId)).toEqual(open.map((team) => team.id));

    // The team page: first 20 incoming requests per direction with counts, then the rest.
    const teamPage = await loadTeamPage(open[3]!.auth);
    expect(teamPage?.incomingRequests).toMatchObject({ total: 1, nextCursor: null });
    expect(teamPage?.sentInvites).toMatchObject({ total: 1, nextCursor: null });
    await expect(listTeamJoinRequestsForLeader(open[3]!.auth, TeamJoinRequestDirection.REQUEST)).resolves.toMatchObject({ total: 1 });
    await expect(listTeamJoinRequestsForLeader({ ...open[3]!.auth, manageTokenHash: "0".repeat(64) } as TeamLeaderAuth, TeamJoinRequestDirection.REQUEST)).resolves.toBeNull();
    // Another team's leader never pages this team's requests: the auth names its own team only.
    const elsewhere = await listTeamJoinRequestsForLeader({ ...open[4]!.auth, teamId: open[3]!.id } as TeamLeaderAuth, TeamJoinRequestDirection.REQUEST);
    expect(elsewhere).toBeNull();

    // Once the seeker joins a team the seeker lists close for them.
    const joined = await respondToJoinRequest({ actor: { kind: "seeker", holder: asker }, requestId: invites.items[0]!.id, accept: true });
    expect(joined.ok).toBe(true);
    const moved = await seekerHolder(requester.ticketToken);
    await expect(listSeekerInvites(moved)).resolves.toBeNull();
    await expect(listTeamsLookingForMembers(moved)).resolves.toBeNull();
  });

  it("pages a popular team's incoming requests oldest first", { timeout: 120_000 }, async () => {
    const event = await createEvent({ soloPolicy: SoloPolicy.SOLO_WITH_MATCHING, teamMaxSize: 4 });
    const { team } = await createTeam(event, "Popular");
    const auth = await leaderAuth(team.id);
    await setLookingForMembers(auth, true);
    for (let n = 0; n < 25; n += 1) {
      const seeker = await registerOk(event, `fan${n}`, { mode: "solo", seeker: { headline: `Fan ${n}`, skills: [] } });
      expect((await createJoinRequest({ direction: "REQUEST", seeker: await seekerHolder(seeker.ticketToken), teamId: team.id })).ok).toBe(true);
    }
    const page = await loadTeamPage(auth);
    expect(page?.incomingRequests.items).toHaveLength(20);
    expect(page?.incomingRequests.total).toBe(25);
    expect(page?.sentInvites.total).toBe(0);
    const rest = await listTeamJoinRequestsForLeader(auth, TeamJoinRequestDirection.REQUEST, { cursor: page!.incomingRequests.nextCursor });
    expect(rest).toMatchObject({ total: 25, nextCursor: null });
    expect(rest?.items).toHaveLength(5);
    const all = [...page!.incomingRequests.items, ...rest!.items].map((item) => item.id);
    const expected = await prisma.teamJoinRequest.findMany({
      where: { teamId: team.id, status: TeamJoinRequestStatus.PENDING },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    expect(all).toEqual(expected.map((row) => row.id));
    // Answering one refetches the first page with the new count.
    await respondToJoinRequest({ actor: { kind: "leader", auth }, requestId: all[0]!, accept: false });
    await expect(loadTeamPage(auth)).resolves.toMatchObject({ incomingRequests: { total: 24 } });
  });
});
