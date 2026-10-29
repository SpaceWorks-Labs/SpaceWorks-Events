import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutboxStatus } from "@prisma/client";

/*
 * Attendance confirmation email in the outbox (docs/ATTENDANCE.md): the
 * capability payload, delivery that deletes the row, drops stale questions
 * and expires at the start, and the release copy computed at delivery.
 */

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  checkFind: vi.fn(),
  eligible: vi.fn(),
  release: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    outboxMessage: { updateMany: mocks.updateMany, findMany: mocks.findMany, deleteMany: mocks.deleteMany },
    attendanceCheck: { findUnique: mocks.checkFind },
  },
}));
vi.mock("@/lib/email/attendance", () => ({ sendAttendanceCheckEmail: mocks.send }));
vi.mock("@/lib/core/attendanceCheck/eligible", () => ({ isEligibleRsvp: mocks.eligible }));
vi.mock("@/lib/core/attendanceCheck/release", () => ({ releaseFor: mocks.release }));
vi.mock("@/lib/email/passwordReset", () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock("@/lib/email/emailVerification", () => ({ sendEmailVerificationEmail: vi.fn() }));
vi.mock("@/lib/opsAlerts", () => ({ reportOpsAlert: vi.fn() }));

import { ATTENDANCE_CHECK_KIND, asAttendanceCheckPayload, deliverOutboxBatch, enqueueAttendanceChecks } from "@/lib/outbox";
import { BULK_OUTBOX_KINDS } from "@/lib/outbox/due";
import { containsCapability } from "@/lib/outbox/payloads";
import { hashAttendanceToken } from "@/lib/attendanceToken";

const token = "a".repeat(43);

describe("attendance outbox payload", () => {
  it("is a bulk capability kind", () => {
    expect(ATTENDANCE_CHECK_KIND).toBe("attendance-check");
    expect(BULK_OUTBOX_KINDS).toContain("attendance-check");
    expect(containsCapability("attendance-check", { to: "a@example.test", rsvpId: "r", token })).toBe(true);
  });

  it("validates the capability payload shape", () => {
    expect(asAttendanceCheckPayload({ to: "a@example.test", rsvpId: "rsvp_1", token })).not.toBeNull();
    expect(asAttendanceCheckPayload({ to: "ada-now@example.test", rsvpId: "rsvp_1", token, reminder: true })).not.toBeNull();
    for (const bad of [
      { to: "a@example.test", rsvpId: "rsvp_1", token, reminder: "yes" },
      { to: "a@example.test", rsvpId: "rsvp_1", token: "short" },
      { to: "not-an-email", rsvpId: "rsvp_1", token },
      { to: "a@example.test", token },
      { to: "a@example.test", rsvpId: "r".repeat(65), token },
      null,
      [token],
    ]) expect(asAttendanceCheckPayload(bad as never)).toBeNull();
  });

  it("enqueues one attendance-check row per payload, and nothing for none", async () => {
    const client = { outboxMessage: { createMany: mocks.createMany } };
    await expect(enqueueAttendanceChecks(client as never, [])).resolves.toEqual({ count: 0 });
    expect(mocks.createMany).not.toHaveBeenCalled();
    await enqueueAttendanceChecks(client as never, [
      { to: "a@example.test", rsvpId: "rsvp_1", token },
      { to: "b@example.test", rsvpId: "rsvp_2", token: "b".repeat(43), reminder: true },
    ]);
    const data = mocks.createMany.mock.calls[0]![0].data;
    expect(data[0]).toEqual({ kind: "attendance-check", payload: { to: "a@example.test", rsvpId: "rsvp_1", token } });
    expect(data[1]).toMatchObject({ kind: "attendance-check", payload: { reminder: true } });
  });
});

describe("attendance outbox delivery", () => {
  const message = (payload: Record<string, unknown>) => ({
    id: "msg_1", kind: "attendance-check", payload, status: OutboxStatus.PENDING, attempts: 0,
    availableAt: new Date(), lockedAt: null, sentAt: null, lastError: null, createdAt: new Date("2030-01-01T00:00:00Z"),
  });
  const check = (overrides: Record<string, unknown> = {}) => ({
    tokenHash: hashAttendanceToken(token),
    response: null,
    eventId: "evt_1",
    rsvp: { guestName: "Ada", guestEmail: "ada-now@example.test", user: null },
    event: { title: "Launch", status: "PUBLISHED", startDateTime: new Date(Date.now() + 86_400_000), timezone: "Europe/London", location: "Hall", isOnline: false, attendanceCheckReleaseOnDecline: false, organisation: { name: "Acme" } },
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.deleteMany.mockResolvedValue({ count: 1 });
    mocks.send.mockResolvedValue(undefined);
    mocks.eligible.mockResolvedValue(true);
    mocks.release.mockResolvedValue(null);
  });

  it("sends the current question and deletes the capability row", async () => {
    mocks.findMany.mockResolvedValue([message({ to: "ada-now@example.test", rsvpId: "rsvp_1", token, reminder: true })]);
    mocks.checkFind.mockResolvedValue(check());
    await expect(deliverOutboxBatch()).resolves.toEqual({ sent: 1, failed: 0 });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      // The queued recipient must still match the current registration's address.
      to: "ada-now@example.test", eventTitle: "Launch", organisationName: "Acme", timezone: "Europe/London", location: "Hall",
      attendPath: `/attend/${token}`, recipientName: "Ada", reminder: true, releaseKind: null, releaseRefund: null,
    }));
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({ id: "msg_1", status: OutboxStatus.PROCESSING }) });
    expect(mocks.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: OutboxStatus.SENT }) }));
  });

  it("tells the email what a No would release for this registration, computed at delivery", async () => {
    mocks.findMany.mockResolvedValue([message({ to: "ada-now@example.test", rsvpId: "rsvp_1", token })]);
    mocks.checkFind.mockResolvedValue(check({ event: { ...check().event, attendanceCheckReleaseOnDecline: true } }));
    mocks.release.mockResolvedValue({ kind: "paid", refund: "₹499.00" });
    await deliverOutboxBatch();
    expect(mocks.release).toHaveBeenCalledWith("rsvp_1", true);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ releaseKind: "paid", releaseRefund: "₹499.00" }));
  });

  it("says Online for an online event", async () => {
    mocks.findMany.mockResolvedValue([message({ to: "ada-now@example.test", rsvpId: "rsvp_1", token })]);
    mocks.checkFind.mockResolvedValue(check({ event: { ...check().event, isOnline: true } }));
    await deliverOutboxBatch();
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ location: "Online", reminder: false }));
  });

  it.each([
    ["the check is gone", null, true],
    ["the link was rotated", check({ tokenHash: hashAttendanceToken("b".repeat(43)) }), true],
    ["the guest already answered", check({ response: "ATTENDING" }), true],
    ["the guest is no longer eligible", check(), false],
    ["the event was cancelled", check({ event: { ...check().event, status: "CANCELLED" } }), true],
  ])("drops the question silently when %s", async (_label, row, eligible) => {
    mocks.findMany.mockResolvedValue([message({ to: "ada-now@example.test", rsvpId: "rsvp_1", token })]);
    mocks.checkFind.mockResolvedValue(row);
    mocks.eligible.mockResolvedValue(eligible);
    await expect(deliverOutboxBatch()).resolves.toEqual({ sent: 0, failed: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.deleteMany).toHaveBeenCalledOnce();
  });

  it("expires the question once the event has started", async () => {
    mocks.findMany.mockResolvedValue([message({ to: "ada-now@example.test", rsvpId: "rsvp_1", token })]);
    mocks.checkFind.mockResolvedValue(check({ event: { ...check().event, startDateTime: new Date(Date.now() - 1000) } }));
    await expect(deliverOutboxBatch()).resolves.toEqual({ sent: 0, failed: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.deleteMany).toHaveBeenCalledOnce();
  });

  it("deletes a malformed row instead of retrying it", async () => {
    mocks.findMany.mockResolvedValue([message({ to: "a@example.test", rsvpId: "rsvp_1", token: "bad" })]);
    await expect(deliverOutboxBatch()).resolves.toEqual({ sent: 0, failed: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.deleteMany).toHaveBeenCalledOnce();
  });
});
