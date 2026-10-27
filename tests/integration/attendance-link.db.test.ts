import { EventPermission, EventStatus, RsvpStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Attendance confirmation (docs/ATTENDANCE.md): sharing one guest's link by
 * hand from Guests · People. Same owner/admin rule, event lock and
 * start/cancel rules as sending; no email; the new link replaces any
 * emailed one; audited without the token; never across tenants.
 */

const identity = vi.hoisted(() => ({ id: "" }));
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/publicUrl", () => ({ getRequestOrigin: async () => "https://events.example.test" }));
vi.mock("@/lib/outboxWorker", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/outboxWorker")>()), startOutboxWorker: vi.fn() }));
vi.mock("@/lib/email/attendance", () => ({ sendAttendanceCheckEmail: mocks.send }));

import { prisma } from "@/lib/db";
import { ATTENDANCE_AUDIT, issueAttendanceLinkForUser, loadAttendanceCheckStatus, resolveAttendanceCheckByToken, respondToAttendanceCheck, sendAttendanceChecksForUser } from "@/lib/core/attendanceCheck";
import { issueAttendanceLink } from "@/app/actions/attendance-check";
import { deliverOutboxBatch } from "@/lib/outbox";
import { att, clearAttendanceQueue, guest, makeEvent, makeUser, queuedFor, ref, setUpAttendance, tearDownAttendance, tokenFor } from "./helpers/attendance";

const tokenOf = (path: string) => path.replace(/^\/attend\//, "");

beforeAll(() => setUpAttendance());
beforeEach(async () => {
  identity.id = "";
  mocks.send.mockReset();
  await clearAttendanceQueue();
});
afterAll(() => tearDownAttendance());

describe("sharing one guest's link by hand", () => {
  it("asks a guest not yet asked without emailing them, so a later send skips them", async () => {
    const event = await makeEvent();
    const shared = await guest(event.id);
    const other = await guest(event.id);
    const result = await issueAttendanceLinkForUser(att.ownerId, { ...ref(event), rsvpId: shared.id });
    expect(result).toMatchObject({ ok: true, data: { replaced: false } });
    const path = result.ok ? result.data!.path : "";
    expect(path).toMatch(/^\/attend\/[A-Za-z0-9_-]{43}$/);
    expect(await queuedFor(event.id)).toHaveLength(0);
    expect(await resolveAttendanceCheckByToken(tokenOf(path))).toMatchObject({ attendeeEmail: shared.guestEmail, response: null, closed: null });

    expect(await sendAttendanceChecksForUser(att.ownerId, ref(event))).toEqual({ ok: true, data: { queued: 1 } });
    expect((await queuedFor(event.id)).map((message) => (message.payload as { rsvpId: string }).rsvpId)).toEqual([other.id]);
    const status = await loadAttendanceCheckStatus(await prisma.event.findUniqueOrThrow({ where: { id: event.id } }));
    expect(status).toMatchObject({ asked: 2, noReply: 2, notAsked: 0, remindable: 0 });
    expect(await respondToAttendanceCheck({ token: tokenOf(path), response: "ATTENDING" })).toMatchObject({ ok: true });
  });

  it("replaces an emailed link, which stops working and is not delivered", async () => {
    const event = await makeEvent();
    const rsvp = await guest(event.id);
    await sendAttendanceChecksForUser(att.ownerId, ref(event));
    const emailed = await tokenFor(rsvp.id);
    const result = await issueAttendanceLinkForUser(att.adminId, { ...ref(event), rsvpId: rsvp.id });
    expect(result).toMatchObject({ ok: true, data: { replaced: true } });
    const fresh = tokenOf(result.ok ? result.data!.path : "");
    expect(await resolveAttendanceCheckByToken(emailed)).toBeNull();
    expect(await resolveAttendanceCheckByToken(fresh)).not.toBeNull();
    await deliverOutboxBatch(50);
    expect(mocks.send).not.toHaveBeenCalled();

    // A guest who already answered can get a fresh link to change it.
    await respondToAttendanceCheck({ token: fresh, response: "NOT_ATTENDING" });
    const again = await issueAttendanceLinkForUser(att.ownerId, { ...ref(event), rsvpId: rsvp.id });
    expect(again).toMatchObject({ ok: true, data: { replaced: true } });
    expect(await resolveAttendanceCheckByToken(tokenOf(again.ok ? again.data!.path : ""))).toMatchObject({ response: "NOT_ATTENDING" });
  });

  it("audits the link without the token, and the Server Action returns an absolute link", async () => {
    const event = await makeEvent();
    const rsvp = await guest(event.id);
    identity.id = att.ownerId;
    const result = await issueAttendanceLink({ ...ref(event), rsvpId: rsvp.id });
    expect(result).toMatchObject({ ok: true, data: { replaced: false } });
    const url = result.ok ? result.data!.url : "";
    expect(url).toMatch(/^https:\/\/events\.example\.test\/attend\/[A-Za-z0-9_-]{43}$/);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: ATTENDANCE_AUDIT.linkShared, targetId: event.id } });
    expect(audit).toMatchObject({ actorUserId: att.ownerId, organisationId: att.orgId, metadata: { rsvpId: rsvp.id, replaced: false } });
    expect(JSON.stringify(audit)).not.toContain(url.split("/attend/")[1]);
    // The Emails card's "last sent" line counts emails only.
    expect((await loadAttendanceCheckStatus(await prisma.event.findUniqueOrThrow({ where: { id: event.id } }))).lastSent).toBeNull();
  });

  it("refuses anyone who may not email guests, and every collaborator grant", async () => {
    const event = await makeEvent();
    const rsvp = await guest(event.id);
    const denied = { ok: false, error: "You do not have permission to email attendees." };
    expect(await issueAttendanceLinkForUser(att.memberId, { ...ref(event), rsvpId: rsvp.id })).toEqual(denied);
    expect(await issueAttendanceLinkForUser(att.otherOwnerId, { ...ref(event), rsvpId: rsvp.id })).toEqual(denied);
    const collaborator = await makeUser(`link-collab-${randomUUID().slice(0, 8)}`);
    await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: collaborator, permissions: Object.values(EventPermission) } });
    expect(await issueAttendanceLinkForUser(collaborator, { ...ref(event), rsvpId: rsvp.id })).toEqual(denied);
    expect(await issueAttendanceLinkForUser(null, { ...ref(event), rsvpId: rsvp.id })).toEqual({ ok: false, error: "You must be signed in." });
    expect(await issueAttendanceLinkForUser(att.ownerId, { ...ref(event), rsvpId: rsvp.id, extra: 1 })).toEqual({ ok: false, error: "Invalid request." });
    expect(await prisma.attendanceCheck.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("refuses other events' and other tenants' guests, unconfirmed guests, and closed events", async () => {
    const event = await makeEvent();
    const elsewhere = await makeEvent();
    const foreignGuest = await guest(elsewhere.id);
    expect(await issueAttendanceLinkForUser(att.ownerId, { ...ref(event), rsvpId: foreignGuest.id })).toEqual({ ok: false, error: "Guest not found." });
    const foreignOrg = await makeEvent({ organisationId: att.otherOrgId });
    const foreignOrgGuest = await guest(foreignOrg.id);
    expect(await issueAttendanceLinkForUser(att.ownerId, { organisationSlug: att.orgSlug, eventId: foreignOrg.id, rsvpId: foreignOrgGuest.id })).toEqual({ ok: false, error: "Event not found." });
    expect(await issueAttendanceLinkForUser(att.otherOwnerId, { organisationSlug: att.otherOrgSlug, eventId: foreignOrg.id, rsvpId: (await guest(event.id)).id })).toEqual({ ok: false, error: "Guest not found." });

    const notConfirmed = { ok: false, error: "Only confirmed guests can be asked to confirm attendance." };
    for (const status of [RsvpStatus.WAITLISTED, RsvpStatus.PENDING_APPROVAL, RsvpStatus.REJECTED]) {
      const rsvp = await guest(event.id, status);
      expect(await issueAttendanceLinkForUser(att.ownerId, { ...ref(event), rsvpId: rsvp.id }), status).toEqual(notConfirmed);
    }
    const started = await makeEvent({ start: new Date(Date.now() - 60_000) });
    const startedGuest = await guest(started.id);
    expect(await issueAttendanceLinkForUser(att.ownerId, { ...ref(started), rsvpId: startedGuest.id })).toEqual({ ok: false, error: "This event has started, so guests can no longer be asked." });
    const cancelled = await makeEvent({ status: EventStatus.CANCELLED });
    const cancelledGuest = await guest(cancelled.id);
    expect(await issueAttendanceLinkForUser(att.ownerId, { ...ref(cancelled), rsvpId: cancelledGuest.id })).toEqual({ ok: false, error: "This event is cancelled, so guests cannot be asked." });
    expect(await prisma.attendanceCheck.count({ where: { eventId: { in: [event.id, elsewhere.id, foreignOrg.id, started.id, cancelled.id] } } })).toBe(0);
  });
});
