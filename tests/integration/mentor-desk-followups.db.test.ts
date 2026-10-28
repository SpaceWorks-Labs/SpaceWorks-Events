import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { EventPermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { canViewEventDashboard } from "@/lib/eventAccess";
import { conflictKeysFor } from "@/lib/core/judging";
import { setMentorConflict } from "@/lib/core/mentorDesk/configuration";
import { syncMentorGrantLocked } from "@/lib/core/mentorDesk/grant";
import { syncMentorCrewAfterGrant } from "@/lib/core/mentorDesk/crewLink";
import { cancelHelp, raiseHelp } from "@/lib/core/mentorDesk/help";
import { helpCommand } from "@/lib/core/mentorDesk/helpCommands";
import { bookOfficeHour, cancelOfficeHourBooking, createOfficeHourSlot, rescheduleOfficeHourSlot } from "@/lib/core/mentorDesk/officeHours";
import { saveMentoringRound, setRoundMentorPool, transitionMentoringRound } from "@/lib/core/mentorDesk/rounds";
import { visitCommand } from "@/lib/core/mentorDesk/visits";
import { createTeam, organisationId, organiserId, register, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { addCategory, addMentor, createDeskEvent, goLive, HOUR, local, organiserOf, requestVersion, teamParticipant } from "./helpers/mentorDesk";

// docs/MENTOR_DESK.md "Tests": review follow-ups (grant removal, activation, conflicts, cancels, crew hook).
describe.sequential("mentor desk follow-ups", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(tearDownJudgingSuite);

  async function setup(teams = 2) {
    let event = await createDeskEvent();
    const teamIds: string[] = [];
    for (let i = 0; i < teams; i += 1) teamIds.push((await createTeam(event, `F${i} ${Math.random().toString(36).slice(2, 7)}`)).teamId);
    event = await goLive(event);
    return { event, teamIds, organiser: await organiserOf(event) };
  }
  const slotFor = async (mentor: Awaited<ReturnType<typeof addMentor>>, startIn: number) => {
    const made = await createOfficeHourSlot(mentor, { mentorUserId: mentor.userId, start: local(new Date(Date.now() + startIn)), end: local(new Date(Date.now() + startIn + 30 * 60_000)), capacity: 2 });
    if (!made.ok) throw new Error(made.error);
    return prisma.officeHourSlot.findUniqueOrThrow({ where: { id: made.data.id } });
  };

  it("cleans up everything a removed mentor held", async () => {
    const { event, teamIds, organiser } = await setup();
    const [gone, stays] = [await addMentor(event, "gone"), await addMentor(event, "stays")];
    const slot = await slotFor(gone, HOUR);
    const booked = await bookOfficeHour(await teamParticipant(teamIds[0]!), { slotId: slot.id, expectedVersion: slot.version });
    if (!booked.ok) throw new Error(booked.error);
    const window = { opensAt: local(new Date(Date.now() - 60_000)), closesAt: local(new Date(Date.now() + HOUR)), formSchema: [] };
    const shared = await saveMentoringRound(organiser, { expectedVersion: 0, label: "Shared", ...window });
    const solo = await saveMentoringRound(organiser, { expectedVersion: 0, label: "Solo", ...window });
    if (!shared.ok || !solo.ok) throw new Error("round");
    await setRoundMentorPool(organiser, { roundId: shared.data.id, mentorUserIds: [gone.userId, stays.userId] });
    await setRoundMentorPool(organiser, { roundId: solo.data.id, mentorUserIds: [gone.userId] });
    await transitionMentoringRound(organiser, { roundId: shared.data.id, action: "open", expectedVersion: 2 });
    const round = await prisma.mentoringRound.findUniqueOrThrow({ where: { id: shared.data.id } });
    expect((await visitCommand(gone, { roundId: round.id, teamId: teamIds[1]!, action: "claim", expectedVersion: round.version })).ok).toBe(true);
    await prisma.$transaction((tx) => syncMentorGrantLocked(tx, event.id, gone.userId, [EventPermission.MENTOR], [], organiserId));
    expect(await prisma.officeHourSlot.findUniqueOrThrow({ where: { id: slot.id } })).toMatchObject({ cancelledAt: expect.any(Date) });
    expect(await prisma.officeHourBooking.findUniqueOrThrow({ where: { id: booked.data.id } })).toMatchObject({ status: "CANCELLED", cancelReason: "role_withdrawn" });
    expect((await prisma.officeHourChange.findFirstOrThrow({ where: { slotId: slot.id } })).reason).toBe("role_withdrawn");
    expect(await prisma.outboxMessage.count({ where: { kind: "office-hour-cancelled", payload: { path: ["id"], equals: booked.data.id } } })).toBeGreaterThanOrEqual(2);
    expect((await prisma.mentoringVisit.findFirstOrThrow({ where: { roundId: round.id } })).expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    // Removed from a shared pool; kept (inert) as a round's only member, so that round is not opened to everyone.
    expect(await prisma.mentoringRoundMentor.findMany({ where: { mentorUserId: gone.userId }, select: { roundId: true } })).toEqual([{ roundId: solo.data.id }]);
  });

  it("counts only activated assignments as mentored", async () => {
    const { event, teamIds, organiser } = await setup(1);
    const mentor = await addMentor(event, "proposed");
    const rejected = await prisma.mentorTeamAssignment.create({ data: { eventId: event.id, mentorUserId: mentor.userId, teamId: teamIds[0]!, mode: "MANUAL", status: "PROPOSED" } });
    await prisma.mentorTeamAssignment.update({ where: { id: rejected.id }, data: { status: "ENDED", endedAt: new Date() } });
    expect((await conflictKeysFor(prisma, event.id, [mentor.userId])).get(mentor.userId)?.teamIds.size).toBe(0);
    await expect(prisma.mentorTeamAssignment.create({ data: { eventId: event.id, mentorUserId: mentor.userId, teamId: teamIds[0]!, mode: "MANUAL" } })).rejects.toThrow();
    const proposal = await prisma.mentorTeamAssignment.create({ data: { eventId: event.id, mentorUserId: mentor.userId, teamId: teamIds[0]!, mode: "MANUAL", status: "PROPOSED" } });
    const { transitionAssignment } = await import("@/lib/core/mentorDesk/assignments");
    expect((await transitionAssignment(organiser, { assignmentId: proposal.id, action: "activate", expectedVersion: 1 })).ok).toBe(true);
    expect((await conflictKeysFor(prisma, event.id, [mentor.userId])).get(mentor.userId)?.teamIds.has(teamIds[0]!)).toBe(true);
  });

  it("lets a mentor clear only conflicts they declared, with versions", async () => {
    const { event, teamIds, organiser } = await setup(2);
    const mentor = await addMentor(event, "conflicts");
    const base = { mentorUserId: mentor.userId, kind: "DECLARED" as const, reason: "" };
    expect((await setMentorConflict(organiser, { ...base, teamId: teamIds[0]!, active: true, expectedVersion: 0 })).ok).toBe(true);
    expect(await setMentorConflict(mentor, { ...base, teamId: teamIds[0]!, active: false, expectedVersion: 1 })).toEqual({ ok: false, error: "Only the organisers can change a conflict they recorded." });
    expect((await setMentorConflict(mentor, { ...base, teamId: teamIds[1]!, active: true, expectedVersion: 0 })).ok).toBe(true);
    expect(await setMentorConflict(mentor, { ...base, teamId: teamIds[1]!, active: false, expectedVersion: 7 })).toEqual({ ok: false, error: "This was changed by someone else. Refresh and try again." });
    expect((await setMentorConflict(mentor, { ...base, teamId: teamIds[1]!, active: false, expectedVersion: 1 })).ok).toBe(true);
    expect((await prisma.mentorConflict.findFirstOrThrow({ where: { teamId: teamIds[0]! } })).createdByUserId).toBe(organiserId);
  });

  it("cancels a booking once under concurrency, and rechecks a reschedule", async () => {
    const { event, teamIds } = await setup(2);
    const mentor = await addMentor(event, "resched");
    const [a, b] = await Promise.all(teamIds.map(teamParticipant));
    const slot = await slotFor(mentor, HOUR);
    const booking = await bookOfficeHour(a!, { slotId: slot.id, expectedVersion: slot.version });
    if (!booking.ok) throw new Error(booking.error);
    const results = await Promise.all([cancelOfficeHourBooking(a!, { bookingId: booking.data.id }), cancelOfficeHourBooking(a!, { bookingId: booking.data.id })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const other = await addMentor(event, "other");
    const busy = await slotFor(other, 3 * HOUR);
    await bookOfficeHour(b!, { slotId: busy.id, expectedVersion: busy.version });
    const fresh = await prisma.officeHourSlot.findUniqueOrThrow({ where: { id: slot.id } });
    await bookOfficeHour(b!, { slotId: fresh.id, expectedVersion: fresh.version });
    const move = (startIn: number) => rescheduleOfficeHourSlot(mentor, { slotId: fresh.id, expectedVersion: fresh.version, reason: "Move", start: local(new Date(Date.now() + startIn)), end: local(new Date(Date.now() + startIn + 30 * 60_000)), capacity: 2 });
    expect(await move(3 * HOUR)).toEqual({ ok: false, error: "A booked team has another booking at the new time." });
    expect(await move(-30 * 60_000)).toMatchObject({ ok: false });
    expect((await move(2 * HOUR)).ok).toBe(true);
  });

  it("cancels on a lapsed lease, lets organisers release it, and limits reopening", async () => {
    const { event, teamIds, organiser } = await setup(1);
    await addCategory(event, { key: "general", openLimit: 1 });
    const team = await teamParticipant(teamIds[0]!);
    const mentor = await addMentor(event, "lapse");
    const first = await raiseHelp(team, { categoryKey: "general", summary: "One" });
    if (!first.ok) throw new Error(first.error);
    await helpCommand(mentor, { requestId: first.data.id, action: "claim", expectedVersion: await requestVersion(first.data.id) });
    await prisma.helpRequest.update({ where: { id: first.data.id }, data: { claimExpiresAt: new Date(Date.now() - 1000) } });
    expect((await helpCommand(organiser, { requestId: first.data.id, action: "release", expectedVersion: await requestVersion(first.data.id) })).ok).toBe(true);
    await helpCommand(mentor, { requestId: first.data.id, action: "claim", expectedVersion: await requestVersion(first.data.id) });
    await helpCommand(mentor, { requestId: first.data.id, action: "resolve", expectedVersion: await requestVersion(first.data.id) });
    const second = await raiseHelp(team, { categoryKey: "general", summary: "Two" });
    if (!second.ok) throw new Error(second.error);
    expect(await helpCommand(organiser, { requestId: first.data.id, action: "reopen", expectedVersion: await requestVersion(first.data.id), note: "Again" })).toEqual({ ok: false, error: "This team already has an open request in this category." });
    await helpCommand(mentor, { requestId: second.data.id, action: "claim", expectedVersion: await requestVersion(second.data.id) });
    await prisma.helpRequest.update({ where: { id: second.data.id }, data: { claimExpiresAt: new Date(Date.now() - 1000) } });
    expect((await cancelHelp(team, { requestId: second.data.id, expectedVersion: await requestVersion(second.data.id) })).ok).toBe(true);
  });

  it("gives mentors a crew ticket when the event asks for it, and removes only that one", async () => {
    const { event } = await setup(0);
    await prisma.event.update({ where: { id: event.id }, data: { mentorsGetCrewTicket: true } });
    const mentor = await addMentor(event, "crew-mentor");
    await syncMentorCrewAfterGrant({ eventId: event.id, userId: mentor.userId, before: [], after: [EventPermission.MENTOR], actorUserId: organiserId });
    const profile = await prisma.mentorProfile.findUniqueOrThrow({ where: { eventId_userId: { eventId: event.id, userId: mentor.userId } }, include: { crewMember: { include: { rsvp: true } } } });
    expect(profile.crewMember).toMatchObject({ role: "Mentor", showOnPage: false });
    expect(profile.crewMember?.rsvp).toMatchObject({ isCrew: true, orderId: null, status: "CONFIRMED" });
    await syncMentorCrewAfterGrant({ eventId: event.id, userId: mentor.userId, before: [EventPermission.MENTOR], after: [], actorUserId: organiserId });
    expect(await prisma.eventCrewMember.count({ where: { id: profile.crewMemberId! } })).toBe(0);
    // A mentor who already registered keeps their own ticket; no crew place is made or removed.
    const registered = await addMentor(event, "registered");
    await prisma.event.update({ where: { id: event.id }, data: { startDateTime: new Date(Date.now() + HOUR) } });
    await register(event, "registered", { userId: registered.userId });
    await syncMentorCrewAfterGrant({ eventId: event.id, userId: registered.userId, before: [], after: [EventPermission.MENTOR], actorUserId: organiserId });
    expect((await prisma.mentorProfile.findUniqueOrThrow({ where: { eventId_userId: { eventId: event.id, userId: registered.userId } } })).crewMemberId).toBeNull();
  });

  it("scopes a mentor-only grant's dashboard access (and staff claims) to its own event", async () => {
    const { event } = await setup(0);
    const other = await createDeskEvent();
    const mentor = await addMentor(event, "claims");
    expect(await canViewEventDashboard({ userId: mentor.userId, organisationId, eventId: event.id })).toBe(true);
    expect(await canViewEventDashboard({ userId: mentor.userId, organisationId, eventId: other.id })).toBe(false);
  });
});
