import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { EventPermission, type Event } from "@prisma/client";
import { prisma } from "@/lib/db";
import { addCrewMemberAsOrganiser } from "@/lib/core/crew";
import { syncMentorCrewAfterGrant } from "@/lib/core/mentorDesk/crewLink";
import { bookOfficeHour, createOfficeHourSlot, rescheduleOfficeHourSlot } from "@/lib/core/mentorDesk/officeHours";
import { applyForShift, approveSignup, withdrawSignup } from "@/lib/volunteer/signups";
import { updateShift } from "@/lib/volunteer/shifts";
import type { VolunteerStaff } from "@/lib/volunteer/shared";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { createTeam, organiserId, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { fulfilled, holdLocks, raceBehind } from "./helpers/locks";
import { addMentor, createDeskEvent, goLive, local, teamParticipant } from "./helpers/mentorDesk";

/*
 * docs/VOLUNTEERS.md and docs/MENTOR_DESK.md "Lock order": the person lock
 * (their User row) sits after the Event and before grant, crew, shift and
 * slot locks, so a mentor's booked office hours and their approved volunteer
 * shifts never overlap, whichever is decided first; shift edits lock everyone
 * they may touch in one id-ordered batch.
 */
describe.sequential("volunteer and mentor person locks", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(async () => {
    await flushWebhookEmits();
    await tearDownJudgingSuite();
  });

  const MINUTE = 60_000;
  const at = (minutes: number) => new Date(Math.ceil((Date.now() + minutes * MINUTE) / MINUTE) * MINUTE);
  const BOOKED = "This volunteer has a booked office hour at the same time.";

  async function deskWithShifts(teams = 1) {
    let event = await createDeskEvent();
    const teamIds: string[] = [];
    for (let i = 0; i < teams; i += 1) teamIds.push((await createTeam(event, `V${i} ${Math.random().toString(36).slice(2, 7)}`)).teamId);
    event = await goLive(event);
    event = await prisma.event.update({ where: { id: event.id }, data: { volunteerShiftsEnabled: true, mentorsGetCrewTicket: true } });
    const staff: VolunteerStaff = { organisationId: event.organisationId, eventId: event.id, userId: organiserId, isAdmin: true };
    return { event, staff, teams: await Promise.all(teamIds.map(teamParticipant)) };
  }

  /** A mentor whose crew place is linked only through their profile (`crewMemberId`), never by `userId`. */
  async function profileLinkedMentor(event: Event) {
    const mentor = await addMentor(event, "duty");
    await syncMentorCrewAfterGrant({ eventId: event.id, userId: mentor.userId, before: [], after: [EventPermission.MENTOR], actorUserId: organiserId });
    const { crewMemberId } = await prisma.mentorProfile.findUniqueOrThrow({ where: { eventId_userId: { eventId: event.id, userId: mentor.userId } } });
    await prisma.eventCrewMember.update({ where: { id: crewMemberId! }, data: { userId: null } });
    return { mentor, self: { eventId: event.id, crewMemberId: crewMemberId! } };
  }

  async function guestCrew(event: Event) {
    const added = await addCrewMemberAsOrganiser({ organisationId: event.organisationId, eventId: event.id, actorUserId: organiserId }, { name: "Shift Person", email: `shift-${randomUUID().slice(0, 8)}@example.test`, foodPreference: "", role: "Volunteer" });
    if (!added.ok) throw new Error(added.error);
    return { eventId: event.id, crewMemberId: added.data.id };
  }

  const shift = (event: Event, from: number, minutes = 60, extra: { capacity?: number; requiresApproval?: boolean } = {}) =>
    prisma.volunteerShift.create({ data: { eventId: event.id, title: `Shift ${from}`, startsAt: at(from), endsAt: at(from + minutes), signupDeadline: at(from), capacity: extra.capacity ?? 0, requiresApproval: extra.requiresApproval ?? false } });

  async function slot(mentor: Awaited<ReturnType<typeof addMentor>>, from: number, minutes = 30) {
    const made = await createOfficeHourSlot(mentor, { mentorUserId: mentor.userId, start: local(at(from)), end: local(at(from + minutes)) });
    if (!made.ok) throw new Error(made.error);
    return prisma.officeHourSlot.findUniqueOrThrow({ where: { id: made.data.id } });
  }

  const signupOf = (shiftId: string, crewMemberId: string) => prisma.volunteerShiftSignup.findUniqueOrThrow({ where: { shiftId_crewMemberId: { shiftId, crewMemberId } } });
  const form = (row: Awaited<ReturnType<typeof shift>>, changes: Record<string, unknown> = {}) => ({
    title: row.title, zone: row.zone, task: row.task, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), signupDeadline: row.signupDeadline.toISOString(),
    capacity: row.capacity, waitlistEnabled: row.waitlistEnabled, requiresApproval: row.requiresApproval, graceMinutes: row.graceMinutes, ...changes,
  });

  it("refuses moving a booked office hour onto the mentor's approved shift, through a profile-linked crew place", async () => {
    const { event, teams } = await deskWithShifts(1);
    const { mentor, self } = await profileLinkedMentor(event);
    const duty = await shift(event, 120);
    await expect(applyForShift(self, duty.id)).resolves.toEqual({ ok: true, data: { status: "APPROVED" } });
    const booked = await slot(mentor, 60);
    expect(await bookOfficeHour(teams[0]!, { slotId: booked.id, expectedVersion: booked.version })).toMatchObject({ ok: true });
    const move = (from: number) => rescheduleOfficeHourSlot(mentor, { slotId: booked.id, expectedVersion: booked.version, reason: "Clash", start: local(at(from)), end: local(at(from + 30)) });
    expect(await move(130)).toEqual({ ok: false, error: "The mentor has an approved volunteer shift at that time." });
    expect(await move(190)).toEqual({ ok: true, data: undefined });
  });

  it("refuses approving, auto-approving, promoting or moving a shift onto a booked office hour", async () => {
    const { event, staff, teams } = await deskWithShifts(1);
    const { mentor, self } = await profileLinkedMentor(event);
    const booked = await slot(mentor, 60);
    expect(await bookOfficeHour(teams[0]!, { slotId: booked.id, expectedVersion: booked.version })).toMatchObject({ ok: true });

    const reviewed = await shift(event, 45, 60, { requiresApproval: true });
    await expect(applyForShift(self, reviewed.id)).resolves.toEqual({ ok: true, data: { status: "APPLIED" } });
    await expect(approveSignup(staff, (await signupOf(reviewed.id, self.crewMemberId)).id)).resolves.toEqual({ ok: false, error: BOOKED });

    const open = await shift(event, 70);
    await expect(applyForShift(self, open.id)).resolves.toEqual({ ok: false, error: BOOKED });
    await expect(prisma.volunteerShiftSignup.count({ where: { shiftId: open.id } })).resolves.toBe(0);

    // A full shift: the mentor waits, the place frees up, and promotion skips them.
    const full = await shift(event, 50, 60, { capacity: 1 });
    const other = await guestCrew(event);
    await expect(applyForShift(other, full.id)).resolves.toMatchObject({ data: { status: "APPROVED" } });
    // Waitlisted directly: approving would already refuse the clash.
    await prisma.volunteerShiftSignup.create({ data: { eventId: event.id, shiftId: full.id, crewMemberId: self.crewMemberId, status: "WAITLISTED" } });
    await expect(withdrawSignup({ kind: "self", self: other }, (await signupOf(full.id, other.crewMemberId)).id)).resolves.toMatchObject({ ok: true });
    await expect(signupOf(full.id, self.crewMemberId)).resolves.toMatchObject({ status: "WAITLISTED" });

    const later = await shift(event, 180);
    await expect(applyForShift(self, later.id)).resolves.toMatchObject({ data: { status: "APPROVED" } });
    await expect(updateShift(staff, later.id, form(later, { startsAt: at(40).toISOString(), endsAt: at(100).toISOString(), signupDeadline: at(40).toISOString() }))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("booked office hour") });
  });

  it("decides a booking and a volunteer approval for the same person one at a time", async () => {
    const { event, staff, teams } = await deskWithShifts(1);
    const { mentor, self } = await profileLinkedMentor(event);
    const free = await slot(mentor, 60);
    const duty = await shift(event, 45, 60, { requiresApproval: true });
    await applyForShift(self, duty.id);
    const signup = await signupOf(duty.id, self.crewMemberId);
    const [booking, approval] = await raceBehind(
      await holdLocks(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${mentor.userId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "OfficeHourSlot" WHERE "id" = ${free.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "VolunteerShift" WHERE "id" = ${duty.id} FOR UPDATE`;
      }),
      () => bookOfficeHour(teams[0]!, { slotId: free.id, expectedVersion: free.version }),
      () => approveSignup(staff, signup.id),
    );
    expect(fulfilled(booking)).toMatchObject({ ok: true });
    expect(fulfilled(approval)).toEqual({ ok: false, error: BOOKED });
    await expect(signupOf(duty.id, self.crewMemberId)).resolves.toMatchObject({ status: "APPLIED" });
  });

  it("edits two shifts with crossed rosters at once without deadlocking", async () => {
    const { event, staff } = await deskWithShifts(0);
    for (let round = 0; round < 2; round += 1) {
      const a = await shift(event, 60 + round * 600, 60, { capacity: 1 });
      const b = await shift(event, 240 + round * 600, 60, { capacity: 1 });
      const [x, y] = [await guestCrew(event), await guestCrew(event)];
      await applyForShift(x, a.id);
      await applyForShift(y, b.id);
      await applyForShift(x, b.id);
      await applyForShift(y, a.id);
      // A grace change moves each window: holders are checked and the waitlist may be promoted.
      const [left, right] = await raceBehind(
        await holdLocks((tx) => tx.$queryRaw`SELECT "id" FROM "EventCrewMember" WHERE "id" IN (${x.crewMemberId}, ${y.crewMemberId}) FOR UPDATE`),
        () => updateShift(staff, a.id, form(a, { graceMinutes: 20 })),
        () => updateShift(staff, b.id, form(b, { graceMinutes: 20 })),
      );
      expect([fulfilled(left), fulfilled(right)]).toEqual([{ ok: true, data: undefined }, { ok: true, data: undefined }]);
      await expect(signupOf(a.id, y.crewMemberId)).resolves.toMatchObject({ status: "WAITLISTED" });
    }
  });
});
