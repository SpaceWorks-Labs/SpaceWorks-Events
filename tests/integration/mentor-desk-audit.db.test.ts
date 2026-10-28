import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { EventPermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { liveMentor, resolveParticipantForUser } from "@/lib/core/mentorDesk/access";
import { syncMentorCrewAfterGrant } from "@/lib/core/mentorDesk/crewLink";
import { lockCollaborator, MENTOR_WORK_IN_PROGRESS, requireNoMentoringInProgress, syncMentorGrantLocked } from "@/lib/core/mentorDesk/grant";
import { raiseHelp, raiseHelpAsMentor } from "@/lib/core/mentorDesk/help";
import { helpCommand } from "@/lib/core/mentorDesk/helpCommands";
import { saveMentoringRound, transitionMentoringRound } from "@/lib/core/mentorDesk/rounds";
import { DeskError } from "@/lib/core/mentorDesk/shared";
import { visitCommand } from "@/lib/core/mentorDesk/visits";
import { createTeam, organiserId, orgSlug, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { addCategory, addMentor, createDeskEvent, goLive, heldClaim, HOUR, local, organiserOf, requestVersion, teamParticipant } from "./helpers/mentorDesk";

// docs/MENTOR_DESK.md "Tests": final-audit fixes (grant fencing, crew, help email and limits, rounds, eligibility).
describe.sequential("mentor desk audit fixes", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(tearDownJudgingSuite);

  async function setup(teams = 1) {
    let event = await createDeskEvent();
    const teamIds: string[] = [];
    for (let i = 0; i < teams; i += 1) teamIds.push((await createTeam(event, `A${i} ${Math.random().toString(36).slice(2, 7)}`)).teamId);
    event = await goLive(event);
    await addCategory(event, { key: "general", openLimit: 1 });
    return { event, teamIds, organiser: await organiserOf(event) };
  }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("makes a grant removal wait for a mentor command holding the grant", async () => {
    const { event } = await setup(0);
    const mentor = await addMentor(event, "fenced");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const command = prisma.$transaction(async (tx) => { await liveMentor(tx, event.id, mentor.userId); await gate; }, { timeout: 15_000 });
    await wait(150);
    let removed = false;
    const removal = prisma.$transaction(async (tx) => {
      const row = await lockCollaborator(tx, { eventId: event.id, userId: mentor.userId });
      await syncMentorGrantLocked(tx, event.id, mentor.userId, row!.permissions, [], organiserId);
      await tx.eventCollaborator.delete({ where: { id: row!.id } });
    }, { timeout: 15_000 }).then(() => { removed = true; });
    await wait(400);
    expect(removed).toBe(false);
    release();
    await command;
    await removal;
    expect(removed).toBe(true);
    await expect(prisma.$transaction((tx) => liveMentor(tx, event.id, mentor.userId))).rejects.toThrow(DeskError);
  });

  it("expires a removed mentor's claim past its deadline, and refuses removal while a booked office hour is under way", async () => {
    const { event, teamIds } = await setup(1);
    const mentor = await addMentor(event, "removed");
    const raised = await raiseHelp(await teamParticipant(teamIds[0]!), { categoryKey: "general", summary: "Stuck" });
    if (!raised.ok) throw new Error(raised.error);
    await helpCommand(mentor, { requestId: raised.data.id, action: "claim", expectedVersion: await requestVersion(raised.data.id) });
    const slot = await prisma.officeHourSlot.create({ data: { eventId: event.id, mentorUserId: mentor.userId, startsAt: new Date(Date.now() - 10 * 60_000), endsAt: new Date(Date.now() + 20 * 60_000), bookingDeadline: new Date(Date.now() - 20 * 60_000) } });
    await prisma.officeHourBooking.create({ data: { eventId: event.id, slotId: slot.id, teamId: teamIds[0]! } });
    await expect(prisma.$transaction((tx) => requireNoMentoringInProgress(tx, event.id, mentor.userId))).rejects.toThrow(MENTOR_WORK_IN_PROGRESS);
    await prisma.officeHourBooking.updateMany({ where: { slotId: slot.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await prisma.$transaction((tx) => requireNoMentoringInProgress(tx, event.id, mentor.userId));
    await prisma.helpRequest.update({ where: { id: raised.data.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await prisma.$transaction((tx) => syncMentorGrantLocked(tx, event.id, mentor.userId, [EventPermission.MENTOR], [], organiserId));
    expect(await prisma.helpRequest.findUniqueOrThrow({ where: { id: raised.data.id } })).toMatchObject({ status: "EXPIRED", claimedByUserId: null });
    expect(await prisma.helpRequestActivity.count({ where: { requestId: raised.data.id, kind: "role_ended" } })).toBe(1);
  });

  it("never lets a crew ticket act as a Mentor Desk participant", async () => {
    const { event } = await setup(0);
    await prisma.event.update({ where: { id: event.id }, data: { mentorsGetCrewTicket: true } });
    const mentor = await addMentor(event, "crew-participant");
    await syncMentorCrewAfterGrant({ eventId: event.id, userId: mentor.userId, before: [], after: [EventPermission.MENTOR], actorUserId: organiserId });
    const profile = await prisma.mentorProfile.findUniqueOrThrow({ where: { eventId_userId: { eventId: event.id, userId: mentor.userId } }, include: { crewMember: true } });
    await prisma.rSVP.update({ where: { id: profile.crewMember!.rsvpId }, data: { userId: mentor.userId } });
    expect(await resolveParticipantForUser(mentor.userId, orgSlug, event.id)).toBeNull();
  });

  it("emails the team leader, not the raising mentor, when a mentor-raised request is claimed", async () => {
    const { event, teamIds } = await setup(1);
    await prisma.event.update({ where: { id: event.id }, data: { mentorHelpClaimedEmail: true } });
    const [raiser, claimer] = [await addMentor(event, "raiser"), await addMentor(event, "claimer")];
    const raised = await raiseHelpAsMentor(raiser, { teamId: teamIds[0]!, categoryKey: "general", summary: "Needs a hand" });
    if (!raised.ok) throw new Error(raised.error);
    expect((await helpCommand(claimer, { requestId: raised.data.id, action: "claim", expectedVersion: await requestVersion(raised.data.id) })).ok).toBe(true);
    const message = await prisma.outboxMessage.findFirstOrThrow({ where: { kind: "help-claimed", payload: { path: ["id"], equals: raised.data.id } } });
    const leader = await prisma.team.findUniqueOrThrow({ where: { id: teamIds[0]! }, select: { leaderRsvp: { select: { guestEmail: true } } } });
    const raiserEmail = (await prisma.user.findUniqueOrThrow({ where: { id: raiser.userId } })).email;
    expect((message.payload as { to: string }).to).toBe(leader.leaderRsvp!.guestEmail!.toLowerCase());
    expect((message.payload as { to: string }).to).not.toBe(raiserEmail);
  });

  it("reopens within the open limit even when two reopens race", async () => {
    const { event, teamIds, organiser } = await setup(1);
    const team = await teamParticipant(teamIds[0]!);
    const mentor = await addMentor(event, "reopen");
    const ids: string[] = [];
    for (const summary of ["One", "Two"]) {
      const raised = await raiseHelp(team, { categoryKey: "general", summary });
      if (!raised.ok) throw new Error(raised.error);
      await helpCommand(mentor, { requestId: raised.data.id, action: "claim", expectedVersion: await requestVersion(raised.data.id) });
      expect((await helpCommand(mentor, { requestId: raised.data.id, action: "resolve", ...(await heldClaim(raised.data.id)) })).ok).toBe(true);
      ids.push(raised.data.id);
    }
    const versions = await Promise.all(ids.map(requestVersion));
    const results = await Promise.all(ids.map((requestId, i) => helpCommand(organiser, { requestId, action: "reopen", expectedVersion: versions[i], note: "Again" })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.helpRequest.count({ where: { eventId: event.id, status: "OPEN" } })).toBe(1);
  });

  it("refuses help from a team that is no longer confirmed", async () => {
    const { event, teamIds } = await setup(1);
    const mentor = await addMentor(event, "unconfirmed");
    const raised = await raiseHelp(await teamParticipant(teamIds[0]!), { categoryKey: "general", summary: "Help" });
    if (!raised.ok) throw new Error(raised.error);
    await prisma.team.update({ where: { id: teamIds[0]! }, data: { status: "WAITLISTED" } });
    expect(await helpCommand(mentor, { requestId: raised.data.id, action: "claim", expectedVersion: await requestVersion(raised.data.id) })).toEqual({ ok: false, error: "This request needs another mentor." });
  });

  it("closes a round while a visit heartbeat runs, without deadlocking", async () => {
    const { event, teamIds, organiser } = await setup(1);
    const mentor = await addMentor(event, "visitor");
    const saved = await saveMentoringRound(organiser, { expectedVersion: 0, label: "Stage", opensAt: local(new Date(Date.now() - 60_000)), closesAt: local(new Date(Date.now() + HOUR)), formSchema: [] });
    if (!saved.ok) throw new Error(saved.error);
    await transitionMentoringRound(organiser, { roundId: saved.data.id, action: "open", expectedVersion: 1 });
    const round = await prisma.mentoringRound.findUniqueOrThrow({ where: { id: saved.data.id } });
    const lease = await visitCommand(mentor, { roundId: round.id, teamId: teamIds[0]!, action: "claim", expectedVersion: round.version });
    if (!lease.ok) throw new Error(lease.error);
    const [beat, close] = await Promise.all([
      visitCommand(mentor, { roundId: round.id, teamId: teamIds[0]!, action: "heartbeat", expectedVersion: round.version, leaseId: lease.data.leaseId, generation: lease.data.generation }),
      transitionMentoringRound(organiser, { roundId: round.id, action: "close", expectedVersion: round.version }),
    ]);
    expect(close.ok).toBe(true);
    expect(typeof beat.ok).toBe("boolean");
    expect((await prisma.mentoringVisit.findFirstOrThrow({ where: { roundId: round.id } })).expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
