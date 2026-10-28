import { AttendanceResponse, EventStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Attendance confirmation (docs/ATTENDANCE.md): the 12-hour reminder
 * throttle with link rotation, the guest's reply, token security (shape,
 * digest only, isolation, rotation), the closed states, and the database
 * invariants and retention.
 */

const identity = vi.hoisted(() => ({ id: "" }));
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/outboxWorker")>()), startOutboxWorker: vi.fn() }));
vi.mock("@/lib/email/attendance", () => ({ sendAttendanceCheckEmail: mocks.send }));

import { prisma } from "@/lib/db";
import { ATTENDANCE_AUDIT, loadAttendanceCheckStatus, remindAttendanceChecksForUser, resolveAttendanceCheckByToken, respondToAttendanceCheck, sendAttendanceChecksForUser } from "@/lib/core/attendanceCheck";
import { submitAttendanceReply } from "@/app/actions/attendance-check";
import { generateAttendanceToken, hashAttendanceToken } from "@/lib/attendanceToken";
import { ATTENDANCE_REMINDER_INTERVAL_MS } from "@/lib/attendanceCheck";
import { ageCheck, att, guest, makeEvent, queuedFor, ref, setUpAttendance, tearDownAttendance, tokenFor } from "./helpers/attendance";

beforeAll(() => setUpAttendance());
beforeEach(() => {
  identity.id = "";
  mocks.send.mockReset();
});
afterAll(() => tearDownAttendance());

describe("reminders", () => {
  it("reach only no-reply, still-confirmed guests, at most once per 12 hours, and rotate the link", async () => {
    const event = await makeEvent();
    const silent = await guest(event.id);
    const answered = await guest(event.id);
    const dropped = await guest(event.id);
    expect(await sendAttendanceChecksForUser(att.ownerId, ref(event))).toEqual({ ok: true, data: { queued: 3 } });
    expect(await respondToAttendanceCheck({ token: await tokenFor(answered.id), response: "ATTENDING" })).toMatchObject({ ok: true });

    // Too soon: nobody is due.
    expect(await remindAttendanceChecksForUser(att.ownerId, ref(event))).toEqual({ ok: false, error: "No one is due a reminder. Each guest can be reminded once every 12 hours." });
    // One minute short of 12 hours is still too soon.
    await ageCheck(silent.id, ATTENDANCE_REMINDER_INTERVAL_MS - 60_000);
    expect(await remindAttendanceChecksForUser(att.ownerId, ref(event))).toMatchObject({ ok: false });

    for (const rsvp of [silent, answered, dropped]) await ageCheck(rsvp.id);
    await prisma.rSVP.update({ where: { id: dropped.id }, data: { status: RsvpStatus.WAITLISTED } });
    const oldToken = await tokenFor(silent.id);
    expect(await remindAttendanceChecksForUser(att.adminId, ref(event))).toEqual({ ok: true, data: { queued: 1 } });
    const newToken = await tokenFor(silent.id);
    expect(newToken).not.toBe(oldToken);
    expect(await resolveAttendanceCheckByToken(oldToken)).toBeNull();
    expect(await respondToAttendanceCheck({ token: oldToken, response: "ATTENDING" })).toEqual({ ok: false, error: "This link is no longer valid." });
    expect(await resolveAttendanceCheckByToken(newToken)).toMatchObject({ response: null, closed: null });
    const reminders = (await queuedFor(event.id)).filter((m) => (m.payload as { reminder?: boolean }).reminder === true);
    expect(reminders.map((m) => (m.payload as { rsvpId: string }).rsvpId)).toEqual([silent.id]);

    // Just reminded, so not again.
    expect(await remindAttendanceChecksForUser(att.ownerId, ref(event))).toMatchObject({ ok: false });
    expect(await prisma.auditEvent.findFirst({ where: { action: ATTENDANCE_AUDIT.reminded, targetId: event.id } })).toMatchObject({ actorUserId: att.adminId, metadata: { recipientCount: 1 } });
    const status = await loadAttendanceCheckStatus(await prisma.event.findUniqueOrThrow({ where: { id: event.id } }));
    expect(status).toMatchObject({ coming: 1, notComing: 0, noReply: 1, notAsked: 0, remindable: 0, released: 0 });
    expect(status.lastSent).toMatchObject({ recipientCount: 1 });
  });
});

describe("the guest's reply", () => {
  it("shows only the guest's own details and records Yes, then a change to No, until the start", async () => {
    const event = await makeEvent();
    const rsvp = await guest(event.id);
    await guest(event.id);
    await sendAttendanceChecksForUser(att.ownerId, ref(event));
    const token = await tokenFor(rsvp.id);

    const view = await resolveAttendanceCheckByToken(token);
    expect(view).toMatchObject({
      eventTitle: event.title, organisationName: "Attendance org", timezone: "Europe/London", location: "Main hall",
      attendeeName: rsvp.guestName, attendeeEmail: rsvp.guestEmail, response: null, closed: null, releaseKind: null,
    });
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(rsvp.checkInToken);
    expect(serialised).not.toContain(rsvp.id);
    expect(serialised).not.toContain(hashAttendanceToken(token));

    expect(await submitAttendanceReply({ token, response: "ATTENDING" })).toEqual({ ok: true, data: { response: "ATTENDING", released: false } });
    expect(await submitAttendanceReply({ token, response: "NOT_ATTENDING", note: "  Train strike\u0007 " })).toEqual({ ok: true, data: { response: "NOT_ATTENDING", released: false } });
    const check = await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: rsvp.id } });
    expect(check).toMatchObject({ response: AttendanceResponse.NOT_ATTENDING, note: "Train strike", releaseOutcome: null });
    expect(check.respondedAt).toBeInstanceOf(Date);
    // Without release the place is kept.
    expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: rsvp.id } })).status).toBe(RsvpStatus.CONFIRMED);
    expect(await submitAttendanceReply({ token, response: "ATTENDING", note: "x".repeat(501) })).toEqual({ ok: false, error: "Keep the note to 500 characters or fewer." });
    expect(await submitAttendanceReply({ token, response: "MAYBE" })).toEqual({ ok: false, error: "Choose Yes or No." });
  });

  it("isolates tokens: unknown, malformed, digests and other events' links reveal nothing", async () => {
    const eventA = await makeEvent();
    const eventB = await makeEvent({ organisationId: att.otherOrgId });
    const a = await guest(eventA.id);
    const b = await guest(eventB.id);
    await sendAttendanceChecksForUser(att.ownerId, ref(eventA));
    await sendAttendanceChecksForUser(att.otherOwnerId, ref(eventB));
    const tokenA = await tokenFor(a.id);
    const tokenB = await tokenFor(b.id);
    expect(tokenA).not.toBe(tokenB);
    expect((await resolveAttendanceCheckByToken(tokenA))?.attendeeEmail).toBe(a.guestEmail);
    expect((await resolveAttendanceCheckByToken(tokenB))?.organisationName).toBe("Attendance other");
    // Only the digest is stored; the raw token appears nowhere in the table.
    const stored = await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: a.id } });
    expect(stored.tokenHash).toBe(hashAttendanceToken(tokenA));
    expect(JSON.stringify(stored)).not.toContain(tokenA);

    expect(await resolveAttendanceCheckByToken(generateAttendanceToken().raw)).toBeNull();
    expect(await resolveAttendanceCheckByToken("short")).toBeNull();
    expect(await resolveAttendanceCheckByToken(hashAttendanceToken(tokenA))).toBeNull();
    expect(await respondToAttendanceCheck({ token: generateAttendanceToken().raw, response: "ATTENDING" })).toEqual({ ok: false, error: "This link is no longer valid." });
    expect(await respondToAttendanceCheck({ token: hashAttendanceToken(tokenA), response: "ATTENDING" })).toEqual({ ok: false, error: "Choose Yes or No." });

    await respondToAttendanceCheck({ token: tokenA, response: "NOT_ATTENDING" });
    expect((await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: b.id } })).response).toBeNull();
  });

  it("closes after the start, when no longer confirmed, and when the event is cancelled", async () => {
    const event = await makeEvent();
    const late = await guest(event.id);
    const moved = await guest(event.id);
    await sendAttendanceChecksForUser(att.ownerId, ref(event));
    const lateToken = await tokenFor(late.id);
    const movedToken = await tokenFor(moved.id);

    await prisma.rSVP.update({ where: { id: moved.id }, data: { status: RsvpStatus.WAITLISTED } });
    expect((await resolveAttendanceCheckByToken(movedToken))?.closed).toBe("notConfirmed");
    expect(await respondToAttendanceCheck({ token: movedToken, response: "ATTENDING" })).toEqual({ ok: false, error: "Your registration is no longer confirmed, so there is nothing to answer." });

    await prisma.event.update({ where: { id: event.id }, data: { status: EventStatus.CANCELLED } });
    expect((await resolveAttendanceCheckByToken(lateToken))?.closed).toBe("cancelled");
    expect(await respondToAttendanceCheck({ token: lateToken, response: "ATTENDING" })).toEqual({ ok: false, error: "This event has been cancelled, so answers are closed." });

    await prisma.event.update({ where: { id: event.id }, data: { status: EventStatus.PUBLISHED, startDateTime: new Date(Date.now() - 60_000) } });
    expect((await resolveAttendanceCheckByToken(lateToken))?.closed).toBe("started");
    expect(await respondToAttendanceCheck({ token: lateToken, response: "ATTENDING" })).toEqual({ ok: false, error: "The event has started, so answers are closed." });
    expect(await prisma.attendanceCheck.count({ where: { eventId: event.id, response: { not: null } } })).toBe(0);
  });
});

describe("retention and invariants", () => {
  it("removes the check with its registration and its event", async () => {
    const event = await makeEvent();
    const rsvp = await guest(event.id);
    await guest(event.id);
    await sendAttendanceChecksForUser(att.ownerId, ref(event));
    await prisma.rSVP.delete({ where: { id: rsvp.id } });
    expect(await prisma.attendanceCheck.count({ where: { rsvpId: rsvp.id } })).toBe(0);
    await prisma.event.delete({ where: { id: event.id } });
    expect(await prisma.attendanceCheck.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("enforces the token shape, note length, reply pair and release outcome", async () => {
    const event = await makeEvent();
    const rsvp = await guest(event.id);
    const base = { rsvpId: rsvp.id, eventId: event.id, sentAt: new Date() };
    await expect(prisma.attendanceCheck.create({ data: { ...base, tokenHash: "not-hex" } })).rejects.toThrow();
    await expect(prisma.attendanceCheck.create({ data: { ...base, tokenHash: generateAttendanceToken().hash, response: AttendanceResponse.ATTENDING } })).rejects.toThrow();
    await expect(prisma.attendanceCheck.create({ data: { ...base, tokenHash: generateAttendanceToken().hash, note: "x".repeat(501) } })).rejects.toThrow();
    await expect(prisma.attendanceCheck.create({ data: { ...base, tokenHash: generateAttendanceToken().hash, releaseOutcome: "multiTicket" } })).rejects.toThrow();
    await expect(prisma.attendanceCheck.create({ data: { ...base, tokenHash: generateAttendanceToken().hash, response: AttendanceResponse.NOT_ATTENDING, respondedAt: new Date(), releaseOutcome: "whatever" } })).rejects.toThrow();
    expect(await prisma.attendanceCheck.count({ where: { rsvpId: rsvp.id } })).toBe(0);
  });
});
