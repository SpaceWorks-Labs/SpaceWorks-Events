import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { applyForShift, approveSignup, declineSignup, withdrawSignup } from "@/lib/volunteer/signups";
import { deleteShift, updateShift } from "@/lib/volunteer/shifts";
import { setUpCrewOrgs, tearDownCrewOrgs } from "./helpers/crew";
import { makeShift, notices, shiftsEvent, staffFor, volunteer } from "./helpers/volunteers";

/* Volunteer shift sign-ups (docs/VOLUNTEERS.md): places under the row lock, FIFO waitlist, overlaps, notices. */

const signupOf = (shiftId: string, crewMemberId: string) => prisma.volunteerShiftSignup.findUniqueOrThrow({ where: { shiftId_crewMemberId: { shiftId, crewMemberId } } });

describe.sequential("volunteer shift sign-ups", () => {
  beforeAll(() => setUpCrewOrgs("vsignups"));
  afterAll(async () => {
    await flushWebhookEmits();
    await tearDownCrewOrgs();
  });

  it("never gives out more places than the shift has, even when sign-ups race", async () => {
    const event = await shiftsEvent();
    const shift = await makeShift(event, { capacity: 2, waitlistEnabled: false });
    const people = await Promise.all(Array.from({ length: 6 }, () => volunteer(event)));
    const results = await Promise.all(people.map(({ self }) => applyForShift(self, shift.id)));
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => !result.ok).every((result) => !result.ok && result.error === "This shift is full.")).toBe(true);
    await expect(prisma.volunteerShiftSignup.count({ where: { shiftId: shift.id, status: "APPROVED" } })).resolves.toBe(2);
    // A refused sign-up leaves nothing behind.
    await expect(prisma.volunteerShiftSignup.count({ where: { shiftId: shift.id } })).resolves.toBe(2);
  });

  it("waitlists when full and promotes first in, first out, skipping anyone now on an overlapping shift", async () => {
    const event = await shiftsEvent();
    const shift = await makeShift(event, { capacity: 1 });
    const clash = await makeShift(event, { capacity: 0, title: "Same time elsewhere" });
    const [first, second, third] = [await volunteer(event), await volunteer(event), await volunteer(event)];
    await expect(applyForShift(first.self, shift.id)).resolves.toEqual({ ok: true, data: { status: "APPROVED" } });
    await expect(applyForShift(second.self, shift.id, new Date(Date.now() + 1000))).resolves.toEqual({ ok: true, data: { status: "WAITLISTED" } });
    await expect(applyForShift(third.self, shift.id, new Date(Date.now() + 2000))).resolves.toEqual({ ok: true, data: { status: "WAITLISTED" } });
    // The second in the queue takes an overlapping place elsewhere, so the third is promoted instead.
    await expect(applyForShift(second.self, clash.id)).resolves.toEqual({ ok: true, data: { status: "APPROVED" } });
    await expect(withdrawSignup({ kind: "self", self: first.self }, (await signupOf(shift.id, first.member.id)).id)).resolves.toEqual({ ok: true, data: undefined });
    await expect(signupOf(shift.id, second.member.id)).resolves.toMatchObject({ status: "WAITLISTED" });
    await expect(signupOf(shift.id, third.member.id)).resolves.toMatchObject({ status: "APPROVED", approvedByUserId: null });
    await expect(notices(third.member.id, "promoted")).resolves.toBe(1);
    await expect(notices(first.member.id, "cancelled")).resolves.toBe(0);
  });

  it("refuses an overlapping approval and keeps declined sign-ups declined, but lets people who withdrew sign up again", async () => {
    const event = await shiftsEvent();
    const morning = await makeShift(event, { requiresApproval: true });
    const overlap = await makeShift(event, { startIn: 120, requiresApproval: true });
    const later = await makeShift(event, { startIn: 180, requiresApproval: true });
    const staff = staffFor(event);
    const { member, self } = await volunteer(event);
    for (const shift of [morning, overlap, later]) await expect(applyForShift(self, shift.id)).resolves.toEqual({ ok: true, data: { status: "APPLIED" } });
    await expect(approveSignup(staff, (await signupOf(morning.id, member.id)).id)).resolves.toEqual({ ok: true, data: { status: "APPROVED" } });
    await expect(notices(member.id, "approved")).resolves.toBe(1);
    // morning runs 60–180 minutes from now; overlap starts at 120; later starts as morning ends.
    await expect(approveSignup(staff, (await signupOf(overlap.id, member.id)).id)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("same time") });
    await expect(approveSignup(staff, (await signupOf(later.id, member.id)).id)).resolves.toMatchObject({ ok: true });
    await expect(declineSignup(staff, (await signupOf(overlap.id, member.id)).id)).resolves.toMatchObject({ ok: true });
    await expect(applyForShift(self, overlap.id)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("declined") });
    await expect(applyForShift(self, later.id)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("already") });
    await withdrawSignup({ kind: "self", self }, (await signupOf(later.id, member.id)).id);
    await expect(applyForShift(self, later.id)).resolves.toEqual({ ok: true, data: { status: "APPLIED" } });
  });

  it("closes sign-ups at the deadline and refuses approvals once the shift has started", async () => {
    const event = await shiftsEvent();
    const started = await makeShift(event, { startIn: -10, requiresApproval: true });
    const { member, self } = await volunteer(event);
    await expect(applyForShift(self, started.id)).resolves.toMatchObject({ ok: false, error: "Sign-ups for this shift are closed." });
    const signup = await prisma.volunteerShiftSignup.create({ data: { eventId: event.id, shiftId: started.id, crewMemberId: member.id } });
    await expect(approveSignup(staffFor(event), signup.id)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("started") });
    const off = await shiftsEvent({ enabled: false });
    const offShift = await makeShift(off);
    const offPerson = await volunteer(off);
    await expect(applyForShift(offPerson.self, offShift.id)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("not open") });
  });

  it("promotes the waitlist when an organiser adds places, and tells volunteers when a shift is cancelled", async () => {
    const event = await shiftsEvent();
    const shift = await makeShift(event, { capacity: 1 });
    const staff = staffFor(event);
    const [a, b] = [await volunteer(event), await volunteer(event)];
    await applyForShift(a.self, shift.id);
    await applyForShift(b.self, shift.id);
    const form = { title: shift.title, zone: shift.zone, task: shift.task, startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString(), signupDeadline: shift.signupDeadline.toISOString(), capacity: 0, waitlistEnabled: true, requiresApproval: false, graceMinutes: 15 };
    await expect(updateShift(staff, shift.id, { ...form, capacity: 2 })).resolves.toEqual({ ok: true, data: undefined });
    await expect(signupOf(shift.id, b.member.id)).resolves.toMatchObject({ status: "APPROVED" });
    await expect(updateShift(staff, shift.id, { ...form, capacity: 1 })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("already have a place") });
    await expect(withdrawSignup({ kind: "staff", staff }, (await signupOf(shift.id, a.member.id)).id)).resolves.toMatchObject({ ok: true });
    await expect(notices(a.member.id, "cancelled")).resolves.toBe(1);
    await expect(deleteShift(staff, shift.id)).resolves.toEqual({ ok: true, data: undefined });
    await expect(notices(b.member.id, "cancelled")).resolves.toBe(1);
    await expect(prisma.volunteerShift.count({ where: { id: shift.id } })).resolves.toBe(0);
  });
});
