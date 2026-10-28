import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { bookOfficeHour, cancelOfficeHourBooking, createOfficeHourSlot, rescheduleOfficeHourSlot } from "@/lib/core/mentorDesk/officeHours";
import { saveMentoringRound, setRoundMentorPool, tookPartInRound, transitionMentoringRound } from "@/lib/core/mentorDesk/rounds";
import { nominateTeam, visitCommand } from "@/lib/core/mentorDesk/visits";
import { loadParticipantDesk, loadPublicMentors } from "@/lib/core/mentorDesk/readsParticipant";
import { createTeam, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { addCategory, addMentor, createDeskEvent, goLive, HOUR, local, organiserOf, teamParticipant } from "./helpers/mentorDesk";

// docs/MENTOR_DESK.md "Tests": office-hour capacity and overlap, round visits, fresh eyes and private nominations.
describe.sequential("mentor desk office hours and rounds", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(tearDownJudgingSuite);

  async function withTeams(count: number) {
    let event = await createDeskEvent();
    const teamIds: string[] = [];
    for (let i = 0; i < count; i += 1) teamIds.push((await createTeam(event, `O${i} ${Math.random().toString(36).slice(2, 7)}`)).teamId);
    event = await goLive(event);
    return { event, teamIds };
  }

  async function slot(mentor: Awaited<ReturnType<typeof addMentor>>, startIn: number, capacity = 1) {
    const created = await createOfficeHourSlot(mentor, { mentorUserId: mentor.userId, start: local(new Date(Date.now() + startIn)), end: local(new Date(Date.now() + startIn + 30 * 60_000)), capacity });
    if (!created.ok) throw new Error(created.error);
    return prisma.officeHourSlot.findUniqueOrThrow({ where: { id: created.data.id } });
  }

  it("fills a slot exactly to capacity when teams book at once, and refuses overlaps", async () => {
    const { event, teamIds } = await withTeams(3);
    const mentor = await addMentor(event, "office");
    const shared = await slot(mentor, HOUR, 2);
    const teams = await Promise.all(teamIds.map(teamParticipant));
    const results = await Promise.all(teams.map((t) => bookOfficeHour(t, { slotId: shared.id, expectedVersion: shared.version })));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.error)).toEqual(["This slot is full."]);
    expect(await prisma.officeHourBooking.count({ where: { slotId: shared.id, status: "BOOKED" } })).toBe(2);
    // The same team cannot hold two overlapping bookings.
    const second = await addMentor(event, "office-2");
    const overlapping = await slot(second, HOUR + 10 * 60_000);
    const booked = results.findIndex((r) => r.ok);
    expect(await bookOfficeHour(teams[booked]!, { slotId: overlapping.id, expectedVersion: overlapping.version })).toEqual({ ok: false, error: "Your team has an overlapping booking." });
  });

  it("logs reschedules with a reason and stops team cancellation once the slot starts", async () => {
    const { event, teamIds } = await withTeams(1);
    const mentor = await addMentor(event, "resched");
    const team = await teamParticipant(teamIds[0]!);
    const s = await slot(mentor, HOUR);
    const booking = await bookOfficeHour(team, { slotId: s.id, expectedVersion: s.version });
    if (!booking.ok) throw new Error(booking.error);
    expect(await prisma.outboxMessage.count({ where: { kind: "office-hour-booked", payload: { path: ["id"], equals: booking.data.id } } })).toBeGreaterThanOrEqual(2);
    expect((await rescheduleOfficeHourSlot(mentor, { slotId: s.id, expectedVersion: s.version, reason: "Room change", start: local(new Date(Date.now() + 2 * HOUR)), end: local(new Date(Date.now() + 2.5 * HOUR)), location: "Room 2" })).ok).toBe(true);
    const change = await prisma.officeHourChange.findFirstOrThrow({ where: { slotId: s.id } });
    expect(change.reason).toBe("Room change");
    await expect(prisma.officeHourChange.update({ where: { id: change.id }, data: { reason: "edited" } })).rejects.toThrow(/append-only/);
    await prisma.officeHourSlot.update({ where: { id: s.id }, data: { startsAt: new Date(Date.now() - 60_000), bookingDeadline: new Date(Date.now() - 60_000) } });
    expect(await cancelOfficeHourBooking(team, { bookingId: booking.data.id })).toEqual({ ok: false, error: "Ask an organiser to cancel a started slot." });
  });

  it("runs one live round with heartbeat leases, fresh eyes, away check-ins and private nominations", async () => {
    const { event, teamIds } = await withTeams(2);
    const organiser = await organiserOf(event);
    await addCategory(event, { key: "followup" });
    const [a, b, outsider] = [await addMentor(event, "visit-a"), await addMentor(event, "visit-b"), await addMentor(event, "outsider")];
    const window = { opensAt: local(new Date(Date.now() - 10 * 60_000)), closesAt: local(new Date(Date.now() + HOUR)) };
    const form = [{ id: "stuck", label: "Stuck?", type: "yesno" }, { id: "notes", label: "Notes", type: "text" }];
    const r1 = await saveMentoringRound(organiser, { expectedVersion: 0, label: "Stage 1", ...window, formSchema: form, helpTriggerRules: [{ key: "stuck", questionId: "stuck", op: "eq", value: true, categoryKey: "followup" }] });
    const r2 = await saveMentoringRound(organiser, { expectedVersion: 0, label: "Stage 2", ...window, formSchema: form });
    if (!r1.ok || !r2.ok) throw new Error("round");
    await setRoundMentorPool(organiser, { roundId: r1.data.id, mentorUserIds: [a.userId, b.userId] });
    expect((await transitionMentoringRound(organiser, { roundId: r1.data.id, action: "open", expectedVersion: 2 })).ok).toBe(true);
    expect(await transitionMentoringRound(organiser, { roundId: r2.data.id, action: "open", expectedVersion: 1 })).toEqual({ ok: false, error: "Close the current round first." });
    const round = await prisma.mentoringRound.findUniqueOrThrow({ where: { id: r1.data.id } });
    const visit = (m: typeof a, teamId: string, action: string, extra: Record<string, unknown> = {}) => visitCommand(m, { roundId: round.id, teamId, action, expectedVersion: round.version, ...extra });
    expect(await visit(outsider, teamIds[0]!, "claim")).toEqual({ ok: false, error: "You are not in this round's mentor pool." });
    const lease = await visit(a, teamIds[0]!, "claim");
    if (!lease.ok) throw new Error(lease.error);
    expect(await visit(b, teamIds[0]!, "claim")).toEqual({ ok: false, error: "Another visit is in progress." });
    const leaseRow = () => prisma.mentoringVisit.findFirstOrThrow({ where: { roundId: round.id, teamId: teamIds[0]! } });
    expect((await visit(a, teamIds[0]!, "heartbeat", { expectedVersion: (await leaseRow()).version, leaseId: lease.data.leaseId, generation: lease.data.generation })).ok).toBe(true);
    expect(await visit(a, teamIds[0]!, "submit", { expectedVersion: (await leaseRow()).version, leaseId: "stale", generation: lease.data.generation, formVersion: round.formVersion, answers: {} })).toEqual({ ok: false, error: "This visit lease expired or moved to another mentor." });
    const submitted = await visit(a, teamIds[0]!, "submit", { expectedVersion: (await leaseRow()).version, leaseId: lease.data.leaseId, generation: lease.data.generation, formVersion: round.formVersion, answers: { stuck: true, notes: "Needs a hand" }, nominate: true });
    expect(submitted.ok).toBe(true);
    // Answers raised follow-up help; the team took part in this round.
    expect(await prisma.helpRequest.count({ where: { teamId: teamIds[0]!, origin: "ROUND" } })).toBe(1);
    expect(await tookPartInRound(prisma, { eventId: event.id, roundId: round.id, teamId: teamIds[0]! })).toBe(true);
    expect(await visit(b, teamIds[0]!, "claim")).toEqual({ ok: false, error: "This team has already been checked in." });
    // An away check-in counts as a visit but cannot nominate, and is not "took part".
    const away = await visit(b, teamIds[1]!, "claim");
    if (!away.ok) throw new Error(away.error);
    const awayRow = await prisma.mentoringVisit.findFirstOrThrow({ where: { roundId: round.id, teamId: teamIds[1]! } });
    expect(await visit(b, teamIds[1]!, "submit", { expectedVersion: awayRow.version, leaseId: away.data.leaseId, generation: away.data.generation, formVersion: round.formVersion, away: true, nominate: true })).toEqual({ ok: false, error: "An away visit cannot nominate a team." });
    expect((await visit(b, teamIds[1]!, "submit", { expectedVersion: awayRow.version, leaseId: away.data.leaseId, generation: away.data.generation, formVersion: round.formVersion, away: true })).ok).toBe(true);
    expect(await nominateTeam(b, { roundId: round.id, teamId: teamIds[1]! })).toEqual({ ok: false, error: "Complete a visit before nominating this team." });
    expect(await tookPartInRound(prisma, { eventId: event.id, roundId: round.id, teamId: teamIds[1]! })).toBe(false);
    // Fresh eyes in the next stage: mentor A never revisits team 0.
    await transitionMentoringRound(organiser, { roundId: round.id, action: "close", expectedVersion: round.version });
    const next = await prisma.mentoringRound.findUniqueOrThrow({ where: { id: r2.data.id } });
    await transitionMentoringRound(organiser, { roundId: next.id, action: "open", expectedVersion: next.version });
    expect(await visitCommand(a, { roundId: next.id, teamId: teamIds[0]!, action: "claim", expectedVersion: next.version + 1 })).toEqual({ ok: false, error: "Choose a team you have not visited." });
    // Nominations stay private: not in the participant view, the public mentor list, or the ledger.
    const nomination = await prisma.mentorNomination.findFirstOrThrow({ where: { roundId: round.id } });
    await expect(prisma.mentorNomination.delete({ where: { id: nomination.id } })).rejects.toThrow(/append-only/);
    const participant = JSON.stringify([await loadParticipantDesk(await teamParticipant(teamIds[0]!)), await loadPublicMentors(event.id)]);
    expect(participant).not.toMatch(/nominat|Needs a hand|affiliation/i);
  });
});
