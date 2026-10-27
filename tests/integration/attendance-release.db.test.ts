import { AttendanceResponse, EventStatus, RegistrationMode, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Attendance confirmation (docs/ATTENDANCE.md): a free place released by a
 * "No" goes through the guest's own cancellation (lib/rsvpCancel.ts), so the
 * waitlist and team rules apply; a refused release keeps the reply with
 * releaseOutcome "failed". Then outbox delivery: sent once, stale questions
 * dropped, expired at the start, and the release copy computed at delivery.
 */

const identity = vi.hoisted(() => ({ id: "" }));
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/outboxWorker")>()), startOutboxWorker: vi.fn() }));
vi.mock("@/lib/email/attendance", () => ({ sendAttendanceCheckEmail: mocks.send }));

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { ATTENDANCE_AUDIT, loadAttendanceCheckStatus, resolveAttendanceCheckByToken, respondToAttendanceCheck, sendAttendanceChecksForUser } from "@/lib/core/attendanceCheck";
import { cancelRegistrationByToken } from "@/lib/rsvpCancel";
import { deliverOutboxBatch } from "@/lib/outbox";
import { generateAttendanceToken } from "@/lib/attendanceToken";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { att, clearAttendanceQueue, guest, makeEvent, queuedFor, ref, setUpAttendance, tearDownAttendance, tokenFor } from "./helpers/attendance";

beforeAll(() => setUpAttendance());
beforeEach(() => {
  identity.id = "";
  mocks.send.mockReset();
  mocks.send.mockResolvedValue(undefined);
});
afterAll(() => tearDownAttendance());

describe("declining a free place with release on", () => {
  it("cancels through the self-cancel core, without revalidating, and promotes the waitlist", async () => {
    const event = await makeEvent({ capacity: 1, releaseOnDecline: true });
    const decliner = await guest(event.id);
    const waiting = await guest(event.id, RsvpStatus.WAITLISTED);
    await sendAttendanceChecksForUser(att.ownerId, ref(event));
    const token = await tokenFor(decliner.id);
    expect((await resolveAttendanceCheckByToken(token))?.releaseKind).toBe("free");

    vi.mocked(revalidatePath).mockClear();
    expect(await respondToAttendanceCheck({ token, response: "NOT_ATTENDING", note: "Sorry" })).toEqual({ ok: true, data: { response: "NOT_ATTENDING", released: true } });
    // Regression: a revalidation inside the reply's Server Action re-renders
    // /attend/:token, now a 404, over the "Your place has been released" screen.
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(await prisma.rSVP.findUnique({ where: { id: decliner.id } })).toBeNull();
    expect(await prisma.attendanceCheck.findUnique({ where: { rsvpId: decliner.id } })).toBeNull();
    expect(await resolveAttendanceCheckByToken(token)).toBeNull();
    expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe(RsvpStatus.CONFIRMED);
    expect(await prisma.auditEvent.findFirst({ where: { action: ATTENDANCE_AUDIT.released, targetId: event.id } })).toMatchObject({ metadata: { rsvpId: decliner.id, paid: false } });

    const status = await loadAttendanceCheckStatus(await prisma.event.findUniqueOrThrow({ where: { id: event.id } }));
    expect(status).toMatchObject({ released: 1, notAsked: 1, asked: 0, releaseOnDecline: true });
    // The promoted guest is "newly confirmed" and can be asked.
    expect(await sendAttendanceChecksForUser(att.ownerId, ref(event))).toEqual({ ok: true, data: { queued: 1 } });
  });

  it("leaves revalidation on for every other self-cancel", async () => {
    const event = await makeEvent();
    const rsvp = await guest(event.id);
    vi.mocked(revalidatePath).mockClear();
    expect(await cancelRegistrationByToken(null, rsvp.checkInToken)).toMatchObject({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith(`/${att.orgSlug}/${event.slug}`);
  });

  it("releases a team member's place and hands leadership to the next member", async () => {
    const event = await makeEvent({ registrationMode: RegistrationMode.TEAM, releaseOnDecline: true });
    const created = await submitRsvpCore({ orgSlug: att.orgSlug, eventSlug: event.slug, guestEmail: `lead-${att.suffix}@example.test`, name: "Leader", answers: {} }, { userId: null, team: { mode: "create", name: `Leaders ${att.suffix}` } });
    if (!created.ok || !created.data) throw new Error("team registration failed");
    const team = await prisma.team.findFirstOrThrow({ where: { eventId: event.id } });
    const joined = await submitRsvpCore({ orgSlug: att.orgSlug, eventSlug: event.slug, guestEmail: `next-${att.suffix}@example.test`, name: "Next", answers: {} }, { userId: null, team: { mode: "join", joinToken: team.joinToken } });
    if (!joined.ok || !joined.data) throw new Error("team join failed");
    const leaderRsvp = await prisma.rSVP.findUniqueOrThrow({ where: { checkInToken: created.data.ticketToken } });
    const memberRsvp = await prisma.rSVP.findUniqueOrThrow({ where: { checkInToken: joined.data.ticketToken } });
    expect(team.leaderRsvpId).toBe(leaderRsvp.id);

    await sendAttendanceChecksForUser(att.ownerId, ref(event));
    expect(await respondToAttendanceCheck({ token: await tokenFor(leaderRsvp.id), response: "NOT_ATTENDING" })).toEqual({ ok: true, data: { response: "NOT_ATTENDING", released: true } });
    expect((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).leaderRsvpId).toBe(memberRsvp.id);
    expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: memberRsvp.id } })).status).toBe(RsvpStatus.CONFIRMED);
    expect(await prisma.attendanceCheck.findUnique({ where: { rsvpId: memberRsvp.id } })).toMatchObject({ response: null });
  });

  it("keeps the place of a guest who is already checked in, recording the answer and the failed release", async () => {
    const event = await makeEvent({ releaseOnDecline: true });
    const here = await guest(event.id, RsvpStatus.CONFIRMED, { checkedInAt: new Date() });
    await sendAttendanceChecksForUser(att.ownerId, ref(event));
    const token = await tokenFor(here.id);
    // Already checked in: the form never promises a release.
    expect((await resolveAttendanceCheckByToken(token))?.releaseKind).toBeNull();
    const result = await respondToAttendanceCheck({ token, response: "NOT_ATTENDING" });
    expect(result).toMatchObject({ ok: true, data: { response: "NOT_ATTENDING", released: false, releaseFailed: expect.stringContaining("checked in") } });
    expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: here.id } })).status).toBe(RsvpStatus.CONFIRMED);
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: here.id } })).toMatchObject({ response: AttendanceResponse.NOT_ATTENDING, releaseOutcome: "failed" });
    // A later Yes clears the outcome.
    await respondToAttendanceCheck({ token, response: "ATTENDING" });
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: here.id } })).toMatchObject({ response: AttendanceResponse.ATTENDING, releaseOutcome: null });
  });

  it("a Yes never releases, even with release on", async () => {
    const event = await makeEvent({ releaseOnDecline: true });
    const rsvp = await guest(event.id);
    await sendAttendanceChecksForUser(att.ownerId, ref(event));
    expect(await respondToAttendanceCheck({ token: await tokenFor(rsvp.id), response: "ATTENDING" })).toEqual({ ok: true, data: { response: "ATTENDING", released: false } });
    expect(await prisma.rSVP.findUnique({ where: { id: rsvp.id } })).not.toBeNull();
  });
});

describe("outbox delivery", () => {
  beforeEach(() => clearAttendanceQueue());

  it("sends the current question once, then deletes the capability row", async () => {
    const event = await makeEvent();
    const rsvp = await guest(event.id);
    await sendAttendanceChecksForUser(att.ownerId, ref(event));
    const token = await tokenFor(rsvp.id);
    await deliverOutboxBatch(50);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: rsvp.guestEmail, eventTitle: event.title, timezone: "Europe/London", location: "Main hall", attendPath: `/attend/${token}`, reminder: false, releaseKind: null }));
    expect(await queuedFor(event.id)).toHaveLength(0);
  });

  it("says a No releases the place only when the switch is on at delivery", async () => {
    const event = await makeEvent();
    await guest(event.id);
    await sendAttendanceChecksForUser(att.ownerId, ref(event));
    await prisma.event.update({ where: { id: event.id }, data: { attendanceCheckReleaseOnDecline: true } });
    await deliverOutboxBatch(50);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ releaseKind: "free" }));
  });

  it("drops a rotated, answered or cancelled-event question without sending it", async () => {
    const event = await makeEvent();
    const rotated = await guest(event.id);
    const answered = await guest(event.id);
    await sendAttendanceChecksForUser(att.ownerId, ref(event));
    await respondToAttendanceCheck({ token: await tokenFor(answered.id), response: "ATTENDING" });
    await prisma.attendanceCheck.update({ where: { rsvpId: rotated.id }, data: { tokenHash: generateAttendanceToken().hash } });
    await deliverOutboxBatch(50);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(await queuedFor(event.id)).toHaveLength(0);

    const cancelled = await makeEvent();
    await guest(cancelled.id);
    await sendAttendanceChecksForUser(att.ownerId, ref(cancelled));
    await prisma.event.update({ where: { id: cancelled.id }, data: { status: EventStatus.CANCELLED } });
    await deliverOutboxBatch(50);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(await queuedFor(cancelled.id)).toHaveLength(0);
  });

  it("expires the question once the event has started", async () => {
    const event = await makeEvent();
    await guest(event.id);
    await sendAttendanceChecksForUser(att.ownerId, ref(event));
    await prisma.event.update({ where: { id: event.id }, data: { startDateTime: new Date(Date.now() - 60_000) } });
    expect((await deliverOutboxBatch(50)).failed).toBeGreaterThanOrEqual(1);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(await queuedFor(event.id)).toHaveLength(0);
  });
});
