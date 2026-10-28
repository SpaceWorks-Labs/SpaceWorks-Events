import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { EventPermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { applyAssignments, assignMentorManually, previewAssignments } from "@/lib/core/mentorDesk/assignments";
import { syncMentorCrewAfterGrant } from "@/lib/core/mentorDesk/crewLink";
import { bookOfficeHour, cancelBookingAsOrganiser, cancelOfficeHourBooking, createOfficeHourSlot } from "@/lib/core/mentorDesk/officeHours";
import { saveMentoringRound, transitionMentoringRound } from "@/lib/core/mentorDesk/rounds";
import { createTeam, organiserId, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { addMentor, createDeskEvent, goLive, HOUR, local, organiserOf, teamParticipant } from "./helpers/mentorDesk";

// docs/MENTOR_DESK.md "Tests": final-audit fixes (assignment runs, off-shift preview, office-hour duty and reasons).
describe.sequential("mentor desk audit fixes: assignments and office hours", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(tearDownJudgingSuite);

  async function withTeams(count: number) {
    let event = await createDeskEvent();
    const teamIds: string[] = [];
    for (let i = 0; i < count; i += 1) teamIds.push((await createTeam(event, `B${i} ${Math.random().toString(36).slice(2, 7)}`)).teamId);
    event = await goLive(event);
    return { event, teamIds, organiser: await organiserOf(event) };
  }

  it("refuses runs in a closed round and skips teams already covered on re-apply", async () => {
    const { event, organiser, teamIds } = await withTeams(3);
    await addMentor(event, "cover-a", { maxActiveTeams: 5 });
    await addMentor(event, "cover-b", { maxActiveTeams: 5 });
    const first = await previewAssignments(organiser, { mode: "ROUND_ROBIN" });
    if (!first.ok) throw new Error(first.error);
    expect(first.data.skipped).toEqual([]);
    await applyAssignments(organiser, { mode: "ROUND_ROBIN", fingerprint: first.data.fingerprint });
    const again = await previewAssignments(organiser, { mode: "ROUND_ROBIN" });
    if (!again.ok) throw new Error(again.error);
    expect(again.data.assignments).toEqual([]);
    expect(again.data.skipped.map((s) => s.teamId).sort()).toEqual([...teamIds].sort());
    expect(await applyAssignments(organiser, { mode: "ROUND_ROBIN", fingerprint: again.data.fingerprint })).toMatchObject({ ok: true, data: { created: 0, skipped: 3 } });
    expect(await prisma.mentorTeamAssignment.count({ where: { eventId: event.id, endedAt: null } })).toBe(3);

    const saved = await saveMentoringRound(organiser, { expectedVersion: 0, label: "Done", opensAt: local(new Date(Date.now() - 60_000)), closesAt: local(new Date(Date.now() + HOUR)), formSchema: [] });
    if (!saved.ok) throw new Error(saved.error);
    await transitionMentoringRound(organiser, { roundId: saved.data.id, action: "skip", expectedVersion: 1 });
    expect(await previewAssignments(organiser, { mode: "ROUND_ROBIN", roundId: saved.data.id })).toEqual({ ok: false, error: "This round has closed." });
    const mentor = await prisma.mentorProfile.findFirstOrThrow({ where: { eventId: event.id } });
    expect(await assignMentorManually(organiser, { roundId: saved.data.id, mentorUserId: mentor.userId, teamId: teamIds[0]! })).toEqual({ ok: false, error: "This round has closed." });
  });

  it("previews only mentors on shift unless asked, and fingerprints and audits the seed", async () => {
    const { event, organiser } = await withTeams(2);
    const on = await addMentor(event, "on-shift");
    const off = await addMentor(event, "off-shift", { availability: [{ startsAt: new Date(Date.now() + 2 * HOUR), endsAt: new Date(Date.now() + 3 * HOUR) }] });
    const onShift = await previewAssignments(organiser, { mode: "ROUND_ROBIN" });
    const everyone = await previewAssignments(organiser, { mode: "ROUND_ROBIN", includeOffShift: true });
    if (!onShift.ok || !everyone.ok) throw new Error("preview");
    expect(new Set(onShift.data.assignments.map((a) => a.mentorUserId))).toEqual(new Set([on.userId]));
    expect(new Set(everyone.data.assignments.map((a) => a.mentorUserId))).toEqual(new Set([on.userId, off.userId]));
    const [a, b] = await Promise.all(["a", "b"].map((c) => previewAssignments(organiser, { mode: "RANDOM", seed: c.repeat(32) })));
    if (!a?.ok || !b?.ok) throw new Error("preview");
    expect(a.data.fingerprint).not.toBe(b.data.fingerprint);
    // A seed other than the previewed one is refused as stale.
    expect(await applyAssignments(organiser, { mode: "RANDOM", seed: "b".repeat(32), fingerprint: a.data.fingerprint })).toEqual({ ok: false, error: "The mentors or teams changed; refresh the preview." });
    const applied = await applyAssignments(organiser, { mode: "RANDOM", seed: "a".repeat(32), fingerprint: a.data.fingerprint });
    if (!applied.ok) throw new Error(applied.error);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "MENTOR_ASSIGNMENT_RUN_APPLIED", targetId: applied.data.runId } });
    expect(audit.metadata).toMatchObject({ seed: "a".repeat(32), skipped: 0 });
  });

  it("refuses a booking while the mentor is on an approved volunteer shift, and logs cancellation reasons", async () => {
    const { event, teamIds, organiser } = await withTeams(2);
    await prisma.event.update({ where: { id: event.id }, data: { mentorsGetCrewTicket: true } });
    const mentor = await addMentor(event, "on-duty");
    await syncMentorCrewAfterGrant({ eventId: event.id, userId: mentor.userId, before: [], after: [EventPermission.MENTOR], actorUserId: organiserId });
    const { crewMemberId } = await prisma.mentorProfile.findUniqueOrThrow({ where: { eventId_userId: { eventId: event.id, userId: mentor.userId } } });
    const slotAt = async (startIn: number) => {
      const made = await createOfficeHourSlot(mentor, { mentorUserId: mentor.userId, start: local(new Date(Date.now() + startIn)), end: local(new Date(Date.now() + startIn + 30 * 60_000)), capacity: 2 });
      if (!made.ok) throw new Error(made.error);
      return prisma.officeHourSlot.findUniqueOrThrow({ where: { id: made.data.id } });
    };
    const busy = await slotAt(HOUR);
    const free = await slotAt(2 * HOUR);
    const shift = await prisma.volunteerShift.create({ data: { eventId: event.id, title: "Door", startsAt: new Date(Date.now() + 50 * 60_000), endsAt: new Date(Date.now() + 80 * 60_000), signupDeadline: new Date(Date.now() + 30 * 60_000) } });
    await prisma.volunteerShiftSignup.create({ data: { eventId: event.id, shiftId: shift.id, crewMemberId: crewMemberId!, status: "APPROVED" } });
    const [a, b] = await Promise.all(teamIds.map(teamParticipant));
    expect(await bookOfficeHour(a!, { slotId: busy.id, expectedVersion: busy.version })).toEqual({ ok: false, error: "The mentor is unavailable." });
    const booked = await bookOfficeHour(a!, { slotId: free.id, expectedVersion: free.version });
    const other = await bookOfficeHour(b!, { slotId: free.id, expectedVersion: free.version });
    if (!booked.ok || !other.ok) throw new Error("booking");
    expect((await cancelOfficeHourBooking(a!, { bookingId: booked.data.id, reason: "We fixed it ourselves" })).ok).toBe(true);
    expect((await cancelBookingAsOrganiser(organiser, { bookingId: other.data.id })).ok).toBe(true);
    const log = await prisma.officeHourChange.findMany({ where: { slotId: free.id }, orderBy: { createdAt: "asc" }, select: { reason: true } });
    expect(log.map((row) => row.reason)).toEqual(["We fixed it ourselves", "organiser"]);
    expect(await prisma.officeHourBooking.findUniqueOrThrow({ where: { id: booked.data.id } })).toMatchObject({ status: "CANCELLED", cancelReason: "team_cancelled" });
  });
});
