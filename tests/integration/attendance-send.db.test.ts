import { EventPermission, EventPrivacyType, EventStatus, RegistrationMode, RsvpStatus, type Event } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Attendance confirmation (docs/ATTENDANCE.md): nothing is sent without an
 * explicit organiser action; only CONFIRMED registrations of a one-off event
 * are asked, once each, even under concurrent sends; series dates never;
 * only organisation owners/admins may send (the broadcast rule; no
 * collaborator grant covers emailing guests), and never across tenants.
 */

const identity = vi.hoisted(() => ({ id: "" }));
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/outboxWorker")>()), startOutboxWorker: vi.fn() }));
vi.mock("@/lib/email/attendance", () => ({ sendAttendanceCheckEmail: mocks.send }));

import { prisma } from "@/lib/db";
import {
  ATTENDANCE_AUDIT,
  previewAttendanceCheckSendForUser,
  remindAttendanceChecksForUser,
  sendAttendanceChecksForUser,
  setAttendanceReleaseOnDeclineForUser,
} from "@/lib/core/attendanceCheck";
import { sendAttendanceChecks } from "@/app/actions/attendance-check";
import { runScheduledJobs } from "@/lib/outboxWorker";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { att, guest, makeEvent, makeUser, queuedFor, ref, setUpAttendance, tearDownAttendance, FUTURE_START } from "./helpers/attendance";

beforeAll(() => setUpAttendance());
beforeEach(() => {
  identity.id = "";
  mocks.send.mockReset();
});
afterAll(() => tearDownAttendance());

describe("nothing is ever sent automatically", () => {
  it("the scheduled jobs create no attendance checks and queue no question", async () => {
    const event = await makeEvent({ start: new Date(Date.now() + 24 * 3_600_000) });
    await guest(event.id);
    await guest(event.id);
    await runScheduledJobs({ force: true });
    await runScheduledJobs({ force: true });
    expect(await prisma.attendanceCheck.count({ where: { eventId: event.id } })).toBe(0);
    expect(await queuedFor(event.id)).toHaveLength(0);
  });

  it("previewing a send is read-only", async () => {
    const event = await makeEvent();
    await guest(event.id);
    expect(await previewAttendanceCheckSendForUser(att.ownerId, ref(event))).toEqual({ ok: true, data: { count: 1, firstSend: true, eventStart: event.startDateTime.toISOString() } });
    expect(await prisma.attendanceCheck.count({ where: { eventId: event.id } })).toBe(0);
    expect(await queuedFor(event.id)).toHaveLength(0);
  });
});

describe("who is asked", () => {
  it("asks only CONFIRMED registrations of this event, one email each", async () => {
    const event = await makeEvent();
    const other = await makeEvent();
    const confirmed = [await guest(event.id), await guest(event.id)];
    const user = await prisma.rSVP.create({ data: { eventId: event.id, userId: att.memberId, attendeeKey: `user:${att.memberId}`, status: RsvpStatus.CONFIRMED } });
    for (const status of [RsvpStatus.WAITLISTED, RsvpStatus.PENDING_APPROVAL, RsvpStatus.REJECTED]) await guest(event.id, status);
    await guest(other.id);

    expect(await sendAttendanceChecksForUser(att.ownerId, ref(event))).toEqual({ ok: true, data: { queued: 3 } });
    const checks = await prisma.attendanceCheck.findMany({ where: { eventId: event.id } });
    expect(checks.map((check) => check.rsvpId).sort()).toEqual([...confirmed.map((r) => r.id), user.id].sort());
    expect(checks.every((check) => check.response === null && /^[0-9a-f]{64}$/.test(check.tokenHash))).toBe(true);
    expect(await prisma.attendanceCheck.count({ where: { eventId: other.id } })).toBe(0);

    const queued = await queuedFor(event.id);
    expect(queued).toHaveLength(3);
    const memberEmail = (await prisma.user.findUniqueOrThrow({ where: { id: att.memberId } })).email;
    expect(queued.map((message) => (message.payload as { to: string }).to)).toContain(memberEmail);
    for (const message of queued) expect(Object.keys(message.payload as object).sort()).toEqual(["rsvpId", "to", "token"]);
    const audit = await prisma.auditEvent.findFirst({ where: { action: ATTENDANCE_AUDIT.sent, targetId: event.id } });
    expect(audit).toMatchObject({ actorUserId: att.ownerId, organisationId: att.orgId, targetType: "Event", metadata: { recipientCount: 3, firstSend: true } });
    // Counts only: the audit never names a guest or carries a token.
    expect(JSON.stringify(audit)).not.toMatch(/@example\.test|token/);
  });

  it("asks each member of a team individually", async () => {
    const event = await makeEvent({ registrationMode: RegistrationMode.TEAM });
    const leader = await submitRsvpCore({ orgSlug: att.orgSlug, eventSlug: event.slug, guestEmail: `leader-${att.suffix}@example.test`, name: "Team Leader", answers: {} }, { userId: null, team: { mode: "create", name: `Crew ${att.suffix}` } });
    expect(leader.ok).toBe(true);
    const team = await prisma.team.findFirstOrThrow({ where: { eventId: event.id } });
    const joined = await submitRsvpCore({ orgSlug: att.orgSlug, eventSlug: event.slug, guestEmail: `member-${att.suffix}@example.test`, name: "Team Member", answers: {} }, { userId: null, team: { mode: "join", joinToken: team.joinToken } });
    expect(joined.ok).toBe(true);
    expect(await sendAttendanceChecksForUser(att.ownerId, ref(event))).toEqual({ ok: true, data: { queued: 2 } });
  });

  it("never asks series dates or passes (Event rows only)", async () => {
    const series = await prisma.eventSeries.create({
      data: { organisationId: att.orgId, title: "Weekly", slug: `weekly-${att.suffix}`, recurrenceRule: "FREQ=WEEKLY;COUNT=2", timezone: "UTC", privacyType: EventPrivacyType.PUBLIC, status: EventStatus.PUBLISHED },
    });
    const instance = await prisma.eventInstance.create({ data: { eventSeriesId: series.id, startDateTime: FUTURE_START, endDateTime: new Date(FUTURE_START.getTime() + 3_600_000) } });
    const dated = await prisma.rSVP.create({ data: { eventInstanceId: instance.id, attendeeKey: `guest:series-${att.suffix}`, guestEmail: `series-${att.suffix}@example.test`, status: RsvpStatus.CONFIRMED } });
    expect(await sendAttendanceChecksForUser(att.ownerId, { organisationSlug: att.orgSlug, eventId: series.id })).toEqual({ ok: false, error: "Event not found." });
    expect(await sendAttendanceChecksForUser(att.ownerId, { organisationSlug: att.orgSlug, eventId: instance.id })).toEqual({ ok: false, error: "Event not found." });
    // Even a direct attempt to attach a check to a series registration can't reach any event's send.
    expect(await prisma.attendanceCheck.count({ where: { rsvpId: dated.id } })).toBe(0);
  });
});

describe("sending is idempotent", () => {
  it("never asks anyone twice, even when two organisers send at once", async () => {
    const event = await makeEvent();
    for (let i = 0; i < 6; i += 1) await guest(event.id);
    const [a, b] = await Promise.all([sendAttendanceChecksForUser(att.ownerId, ref(event)), sendAttendanceChecksForUser(att.adminId, ref(event))]);
    expect([a, b].reduce((sum, result) => sum + (result.ok ? result.data?.queued ?? 0 : 0), 0)).toBe(6);
    expect([a, b].filter((result) => !result.ok)).toEqual([{ ok: false, error: "Every confirmed guest has already been asked." }]);
    expect(await prisma.attendanceCheck.count({ where: { eventId: event.id } })).toBe(6);
    expect(await queuedFor(event.id)).toHaveLength(6);
  });

  it("a repeat send asks only guests confirmed since, and says so when there is no one", async () => {
    const event = await makeEvent();
    const first = await guest(event.id);
    expect(await sendAttendanceChecksForUser(att.ownerId, ref(event))).toEqual({ ok: true, data: { queued: 1 } });
    expect(await sendAttendanceChecksForUser(att.ownerId, ref(event))).toEqual({ ok: false, error: "Every confirmed guest has already been asked." });
    const waitlisted = await guest(event.id, RsvpStatus.WAITLISTED);
    const later = await guest(event.id);
    await prisma.rSVP.update({ where: { id: waitlisted.id }, data: { status: RsvpStatus.CONFIRMED } });
    expect(await previewAttendanceCheckSendForUser(att.ownerId, ref(event))).toMatchObject({ ok: true, data: { count: 2, firstSend: false } });
    expect(await sendAttendanceChecksForUser(att.adminId, ref(event))).toEqual({ ok: true, data: { queued: 2 } });
    const checks = await prisma.attendanceCheck.findMany({ where: { eventId: event.id }, select: { rsvpId: true } });
    expect(checks.map((check) => check.rsvpId).sort()).toEqual([first.id, waitlisted.id, later.id].sort());
    expect((await queuedFor(event.id)).filter((m) => (m.payload as { rsvpId: string }).rsvpId === first.id)).toHaveLength(1);
  });
});

describe("when sending is refused", () => {
  it("refuses after the event starts and for a cancelled event", async () => {
    const started = await makeEvent({ start: new Date(Date.now() - 60_000) });
    await guest(started.id);
    expect(await sendAttendanceChecksForUser(att.ownerId, ref(started))).toEqual({ ok: false, error: "This event has started, so guests can no longer be asked." });
    expect(await previewAttendanceCheckSendForUser(att.ownerId, ref(started))).toMatchObject({ ok: false });
    expect(await remindAttendanceChecksForUser(att.ownerId, ref(started))).toEqual({ ok: false, error: "This event has started, so guests can no longer be reminded." });
    const cancelled = await makeEvent({ status: EventStatus.CANCELLED });
    await guest(cancelled.id);
    expect(await sendAttendanceChecksForUser(att.ownerId, ref(cancelled))).toEqual({ ok: false, error: "This event is cancelled, so guests cannot be asked." });
    expect(await previewAttendanceCheckSendForUser(att.ownerId, ref(cancelled))).toEqual({ ok: false, error: "This event is cancelled, so guests cannot be asked." });
    expect(await prisma.attendanceCheck.count({ where: { eventId: { in: [started.id, cancelled.id] } } })).toBe(0);
  });

  it("refuses signed-out callers and malformed input", async () => {
    const event = await makeEvent();
    await guest(event.id);
    expect(await sendAttendanceChecksForUser(null, ref(event))).toEqual({ ok: false, error: "You must be signed in." });
    expect(await sendAttendanceChecksForUser(att.ownerId, { ...ref(event), extra: 1 })).toEqual({ ok: false, error: "Invalid request." });
    expect(await sendAttendanceChecks(ref(event))).toEqual({ ok: false, error: "You must be signed in." });
    expect(await prisma.attendanceCheck.count({ where: { eventId: event.id } })).toBe(0);
  });
});

describe("send permission mirrors broadcasts: organisation owners and admins only", () => {
  let event: Event;
  const collaborators = new Map<string, string>();
  const grants: EventPermission[][] = [...Object.values(EventPermission).map((permission) => [permission]), Object.values(EventPermission)];
  const denied = { ok: false, error: "You do not have permission to email attendees." };

  beforeAll(async () => {
    event = await makeEvent();
    await guest(event.id);
    for (const grant of grants) {
      const name = grant.length > 1 ? "all" : grant[0]!.toLowerCase().replace(/_/g, "-");
      const userId = await makeUser(`collab-${name}`);
      await prisma.eventCollaborator.create({ data: { eventId: event.id, userId, permissions: grant } });
      collaborators.set(grant.length > 1 ? "all grants" : grant[0]!, userId);
    }
  });

  it.each(["MEMBER", "other organisation's owner"])("refuses a %s", async (who) => {
    const userId = who === "MEMBER" ? att.memberId : att.otherOwnerId;
    expect(await previewAttendanceCheckSendForUser(userId, ref(event))).toEqual(denied);
    expect(await sendAttendanceChecksForUser(userId, ref(event))).toEqual(denied);
    expect(await remindAttendanceChecksForUser(userId, ref(event))).toEqual(denied);
    expect(await setAttendanceReleaseOnDeclineForUser(userId, { ...ref(event), releaseOnDecline: true })).toEqual(denied);
  });

  it("refuses every collaborator grant, JUDGE included", async () => {
    expect(collaborators.has(EventPermission.JUDGE)).toBe(true);
    for (const [grant, userId] of collaborators) {
      expect(await sendAttendanceChecksForUser(userId, ref(event)), grant).toEqual(denied);
      expect(await remindAttendanceChecksForUser(userId, ref(event)), grant).toEqual(denied);
      expect(await setAttendanceReleaseOnDeclineForUser(userId, { ...ref(event), releaseOnDecline: true }), grant).toEqual(denied);
    }
    expect(await prisma.attendanceCheck.count({ where: { eventId: event.id } })).toBe(0);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).attendanceCheckReleaseOnDecline).toBe(false);
  });

  it("never crosses tenants: another organisation's event under this slug, or this event under theirs", async () => {
    const foreign = await makeEvent({ organisationId: att.otherOrgId });
    await guest(foreign.id);
    expect(await sendAttendanceChecksForUser(att.ownerId, { organisationSlug: att.orgSlug, eventId: foreign.id })).toEqual({ ok: false, error: "Event not found." });
    expect(await sendAttendanceChecksForUser(att.ownerId, ref(foreign))).toEqual(denied);
    expect(await setAttendanceReleaseOnDeclineForUser(att.otherOwnerId, { organisationSlug: att.otherOrgSlug, eventId: event.id, releaseOnDecline: true })).toEqual({ ok: false, error: "Event not found." });
    expect(await prisma.attendanceCheck.count({ where: { eventId: foreign.id } })).toBe(0);
  });

  it("allows the owner (through the Server Action) and an admin", async () => {
    identity.id = att.ownerId;
    expect(await sendAttendanceChecks(ref(event))).toEqual({ ok: true, data: { queued: 1 } });
    await guest(event.id);
    expect(await sendAttendanceChecksForUser(att.adminId, ref(event))).toEqual({ ok: true, data: { queued: 1 } });
  });

  it("audits the release-on-decline switch only when it changes", async () => {
    expect(await setAttendanceReleaseOnDeclineForUser(att.adminId, { ...ref(event), releaseOnDecline: true })).toEqual({ ok: true, data: { releaseOnDecline: true } });
    expect(await setAttendanceReleaseOnDeclineForUser(att.adminId, { ...ref(event), releaseOnDecline: true })).toEqual({ ok: true, data: { releaseOnDecline: true } });
    const audits = await prisma.auditEvent.findMany({ where: { action: ATTENDANCE_AUDIT.settings, targetId: event.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: att.adminId, metadata: { releaseOnDecline: true } });
  });
});
