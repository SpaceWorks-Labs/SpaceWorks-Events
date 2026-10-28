import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { removeCrewMember } from "@/lib/core/crew";
import { applyForShift } from "@/lib/volunteer/signups";
import { checkInToShift, checkOutOfShift, markNoShow } from "@/lib/volunteer/attendance";
import { adjustHours, verifyHours } from "@/lib/volunteer/hours";
import { crew, ctxFor, setUpCrewOrgs, tearDownCrewOrgs } from "./helpers/crew";
import { makeShift, secondAdmin, shiftsEvent, staffFor, tearDownUsers, volunteer, workedHours } from "./helpers/volunteers";

/* Shift attendance and hours (docs/VOLUNTEERS.md): windows, one duty at a time, second-person verification, append-only history. */

const MINUTE = 60_000;
const users: string[] = [];

describe.sequential("volunteer attendance and hours", () => {
  beforeAll(() => setUpCrewOrgs("vhours"));
  afterAll(async () => {
    await flushWebhookEmits();
    await tearDownUsers(users);
    await tearDownCrewOrgs();
  });

  it("checks volunteers in inside the grace window, one duty at a time, and records pending hours at check-out", async () => {
    const event = await shiftsEvent();
    const soon = await makeShift(event, { startIn: 10, graceMinutes: 15 });
    const later = await makeShift(event, { startIn: 300, graceMinutes: 15 });
    const parallel = await makeShift(event, { startIn: 5, length: 30, graceMinutes: 15, title: "Parallel" });
    const { member, self } = await volunteer(event);
    const other = await volunteer(event);
    await applyForShift(self, soon.id);
    await applyForShift(self, later.id);
    await applyForShift(other.self, parallel.id);
    const signup = (shiftId: string, id = member.id) => prisma.volunteerShiftSignup.findUniqueOrThrow({ where: { shiftId_crewMemberId: { shiftId, crewMemberId: id } } });
    const soonSignup = await signup(soon.id);
    await expect(checkInToShift({ kind: "self", self }, (await signup(later.id)).id)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Check-in opens") });
    await expect(checkInToShift({ kind: "self", self }, soonSignup.id)).resolves.toEqual({ ok: true, data: undefined });
    await expect(checkInToShift({ kind: "self", self }, soonSignup.id)).resolves.toMatchObject({ ok: false });
    // Someone else's sign-up is not found from this ticket.
    await expect(checkInToShift({ kind: "self", self }, (await signup(parallel.id, other.member.id)).id)).resolves.toMatchObject({ ok: false, error: "Sign-up not found." });
    // One active duty: a second check-in waits for check-out (forced into the window through the desk path).
    const now = new Date();
    await expect(checkInToShift({ kind: "self", self }, (await signup(later.id)).id, undefined, new Date(later.startsAt.getTime() - 5 * MINUTE))).resolves.toMatchObject({ ok: false, error: "Check out of the other shift first." });
    const out = await checkOutOfShift({ kind: "self", self }, soonSignup.id, undefined, new Date(now.getTime() + 40 * MINUTE));
    expect(out).toMatchObject({ ok: true });
    await expect(prisma.volunteerHours.findUniqueOrThrow({ where: { signupId: soonSignup.id } })).resolves.toMatchObject({ state: "PENDING", version: 0 });
    // Event check-in is untouched by shift attendance.
    await expect(prisma.rSVP.findUniqueOrThrow({ where: { id: member.rsvpId } })).resolves.toMatchObject({ checkedInAt: null });
  });

  it("lets the desk enter an earlier time only with a reason, refuses overlapping counted time, and marks no-shows after the end", async () => {
    const event = await shiftsEvent();
    const staff = staffFor(event);
    const desk = { kind: "desk" as const, staff };
    const past = await prisma.volunteerShift.create({ data: { eventId: event.id, title: "Morning", startsAt: new Date(Date.now() - 300 * MINUTE), endsAt: new Date(Date.now() - 120 * MINUTE), signupDeadline: new Date(Date.now() - 300 * MINUTE) } });
    const twin = await prisma.volunteerShift.create({ data: { eventId: event.id, title: "Morning twin", startsAt: new Date(Date.now() - 300 * MINUTE), endsAt: new Date(Date.now() - 120 * MINUTE), signupDeadline: new Date(Date.now() - 300 * MINUTE) } });
    const { member } = await volunteer(event);
    const absent = await volunteer(event);
    const [a, b, c] = await Promise.all([
      prisma.volunteerShiftSignup.create({ data: { eventId: event.id, shiftId: past.id, crewMemberId: member.id, status: "APPROVED" } }),
      prisma.volunteerShiftSignup.create({ data: { eventId: event.id, shiftId: twin.id, crewMemberId: member.id, status: "APPROVED" } }),
      prisma.volunteerShiftSignup.create({ data: { eventId: event.id, shiftId: past.id, crewMemberId: absent.member.id, status: "APPROVED" } }),
    ]);
    const at = (offset: number) => new Date(past.startsAt.getTime() + offset * MINUTE).toISOString();
    await expect(checkInToShift(desk, a.id, { occurredAt: at(0) })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Explain") });
    await expect(checkInToShift(desk, a.id, { occurredAt: at(0), reason: "Forgot to scan" })).resolves.toMatchObject({ ok: true });
    await expect(checkOutOfShift(desk, a.id, { occurredAt: at(120), reason: "Paper sheet", breakMinutes: 15 })).resolves.toEqual({ ok: true, data: { minutes: 105 } });
    await expect(prisma.volunteerAttendanceCorrection.count({ where: { signupId: a.id } })).resolves.toBe(2);
    await checkInToShift(desk, b.id, { occurredAt: at(60), reason: "Paper sheet" });
    await expect(checkOutOfShift(desk, b.id, { occurredAt: at(150), reason: "Paper sheet" })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("overlaps") });
    await expect(checkOutOfShift(desk, b.id, { occurredAt: at(100), reason: "x", breakMinutes: 90 })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Breaks") });
    await expect(markNoShow(staff, c.id)).resolves.toEqual({ ok: true, data: undefined });
    await expect(checkInToShift(desk, c.id, { occurredAt: at(10), reason: "late" })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("no-show") });
  });

  it("needs a second person: the volunteer can never verify or adjust their own hours", async () => {
    const event = await shiftsEvent();
    const admin = await secondAdmin("verify");
    users.push(admin.id);
    // The organiser is also on the crew: linked by account (verified email) and by email.
    await prisma.user.update({ where: { id: crew.organiserId }, data: { emailVerified: new Date() } });
    const organiser = await prisma.user.findUniqueOrThrow({ where: { id: crew.organiserId } });
    const { member } = await volunteer(event, { email: organiser.email, kind: "ORGANISER" });
    expect(member.userId).toBe(crew.organiserId);
    const hours = await workedHours(event, member.id, 90);
    await expect(verifyHours(staffFor(event), hours.id)).resolves.toMatchObject({ ok: false, error: "Another organiser must verify your hours." });
    await expect(verifyHours(staffFor(event, admin.id, false), hours.id)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("owners and admins") });
    await expect(adjustHours(staffFor(event, admin.id), hours.id, 60, "Long break")).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Verify") });
    await expect(verifyHours(staffFor(event, admin.id), hours.id)).resolves.toMatchObject({ ok: true, data: { minutes: 90 } });
    await expect(verifyHours(staffFor(event, admin.id), hours.id)).resolves.toMatchObject({ ok: false });
    await expect(adjustHours(staffFor(event, admin.id), hours.id, 60, " ")).resolves.toMatchObject({ ok: false, error: expect.stringContaining("reason") });
    await expect(adjustHours(staffFor(event, admin.id), hours.id, 1441, "Too much")).resolves.toMatchObject({ ok: false });
    await expect(adjustHours(staffFor(event, admin.id), hours.id, 60, "Long break")).resolves.toMatchObject({ ok: true, data: { minutes: 60 } });
    await expect(prisma.volunteerHours.findUniqueOrThrow({ where: { id: hours.id } })).resolves.toMatchObject({ state: "ADJUSTED", minutes: 60, version: 2 });
    // The database refuses an entry by the volunteer even if the application check were skipped.
    await expect(prisma.volunteerHoursEntry.create({ data: { eventId: event.id, hoursId: hours.id, actorUserId: crew.organiserId, previousVersion: 2, minutes: 10, kind: "ADJUSTED", reason: "Self" } })).rejects.toThrow(/second|verify/i);
  });

  it("keeps hours history append-only in the database, while crew removal and event deletion still clean up", async () => {
    const event = await shiftsEvent();
    const admin = await secondAdmin("append");
    users.push(admin.id);
    const { member } = await volunteer(event);
    const hours = await workedHours(event, member.id, 45);
    await verifyHours(staffFor(event, admin.id), hours.id);
    const entry = await prisma.volunteerHoursEntry.findFirstOrThrow({ where: { hoursId: hours.id } });
    await expect(prisma.volunteerHoursEntry.update({ where: { id: entry.id }, data: { minutes: 600 } })).rejects.toThrow(/append-only/);
    await expect(prisma.volunteerHoursEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.volunteerHours.update({ where: { id: hours.id }, data: { minutes: 600 } })).rejects.toThrow(/verification entry/);
    await expect(prisma.volunteerHours.update({ where: { id: hours.id }, data: { minutes: 600, version: 2, state: "ADJUSTED" } })).rejects.toThrow(/verification entry/);
    await expect(prisma.volunteerHours.delete({ where: { id: hours.id } })).rejects.toThrow(/sign-up/);
    await expect(prisma.volunteerAttendanceCorrection.create({ data: { eventId: event.id, signupId: hours.signupId, action: "check-in", occurredAt: new Date(), reason: "x" } }).then((row) => prisma.volunteerAttendanceCorrection.delete({ where: { id: row.id } }))).rejects.toThrow(/append-only/);
    // Removing the crew member removes their sign-ups, hours and history with them.
    await expect(removeCrewMember(ctxFor(event), member.id)).resolves.toMatchObject({ ok: true });
    await expect(prisma.volunteerHoursEntry.count({ where: { id: entry.id } })).resolves.toBe(0);
    const second = await volunteer(event);
    const more = await workedHours(event, second.member.id, 30);
    await verifyHours(staffFor(event, admin.id), more.id);
    await prisma.event.delete({ where: { id: event.id } });
    await expect(prisma.volunteerHours.count({ where: { id: more.id } })).resolves.toBe(0);
  });
});
