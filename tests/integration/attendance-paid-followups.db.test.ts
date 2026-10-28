import { OrderStatus, PaymentStatus, RefundRequestStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Attendance confirmation on paid tickets, the review follow-ups
 * (docs/ATTENDANCE.md): orders still owed at the desk follow the paid rules;
 * the organiser notice and the refund request happen once per check however
 * often the answer changes; a "Yes" withdraws an open request it opened (and
 * Finance shows the answer beside a decided one); two windows answering at
 * once run one release; the form and the email show the policy's refund.
 */

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/outboxWorker", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/outboxWorker")>()), startOutboxWorker: vi.fn() }));
vi.mock("@/lib/email/attendance", () => ({ sendAttendanceCheckEmail: mocks.send }));

import { prisma } from "@/lib/db";
import { ATTENDANCE_AUDIT, resolveAttendanceCheckByToken, respondToAttendanceCheck } from "@/lib/core/attendanceCheck";
import { decideRefundRequest } from "@/lib/refundRequests";
import { loadEventFinance } from "@/lib/finance";
import { deliverOutboxBatch } from "@/lib/outbox";
import { paid } from "./helpers/paidOrg";
import { deliverAttendanceQueue } from "./helpers/attendance";
import { askAndToken, buyAtDesk, buyPaid, email, noticesTo, owner, paidEvent, setUpPaidAttendance, tearDownPaidAttendance } from "./helpers/attendancePaid";

beforeAll(() => setUpPaidAttendance("Paid attendance follow-ups"));
beforeEach(() => {
  mocks.send.mockReset();
  mocks.send.mockResolvedValue(undefined);
});
afterAll(() => tearDownPaidAttendance());

describe("orders still owed at the desk", () => {
  it("never releases a ticket on a desk order with several tickets", async () => {
    const { event, ticket } = await paidEvent({ kind: "FULL_UNTIL", hours: 24 });
    const order = await buyAtDesk(event, ticket.id, "desk-group", ["desk-friend-1", "desk-friend-2"]);
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    const friend = order.rsvps.find((rsvp) => rsvp.guestEmail === email("desk-friend-1"))!;
    const token = await askAndToken(event, friend.id);
    expect((await resolveAttendanceCheckByToken(token))?.releaseKind).toBeNull();
    expect(await respondToAttendanceCheck({ token, response: "NOT_ATTENDING" })).toMatchObject({ ok: true, data: { released: false } });
    expect(await prisma.rSVP.count({ where: { orderId: order.id, status: RsvpStatus.CONFIRMED } })).toBe(3);
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: friend.id } })).toMatchObject({ releaseOutcome: "multiTicket" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } })).payments).toEqual([expect.objectContaining({ status: PaymentStatus.PENDING })]);
  });

  it("cancels a single desk ticket its buyer gives up, and the owed payment with it", async () => {
    const { event, ticket } = await paidEvent({ kind: "FULL_UNTIL", hours: 24 });
    const order = await buyAtDesk(event, ticket.id, "desk-single");
    const token = await askAndToken(event, order.rsvps[0]!.id);
    // Nothing was paid, so nothing is refunded.
    expect(await resolveAttendanceCheckByToken(token)).toMatchObject({ releaseKind: "paid", releaseRefund: null });
    expect(await respondToAttendanceCheck({ token, response: "NOT_ATTENDING" })).toEqual({ ok: true, data: { response: "NOT_ATTENDING", released: true } });
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: { include: { refunds: true } } } });
    expect(after.status).toBe(OrderStatus.CANCELLED);
    expect(after.payments).toEqual([expect.objectContaining({ status: PaymentStatus.CANCELED, refunds: [] })]);
    expect(await prisma.rSVP.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe("once per check", () => {
  it("tells organisers about a kept place once, however often the answer changes", async () => {
    const { event, ticket } = await paidEvent({ kind: "FULL_UNTIL", hours: 24 });
    const order = await buyPaid(event, ticket.id, "flip", ["flip-friend"]);
    const token = await askAndToken(event, order.rsvps.find((r) => r.guestEmail === email("flip"))!.id);
    const before = await noticesTo(owner.email, "Said No");
    for (const response of ["NOT_ATTENDING", "ATTENDING", "NOT_ATTENDING", "ATTENDING", "NOT_ATTENDING"] as const) {
      expect(await respondToAttendanceCheck({ token, response })).toMatchObject({ ok: true });
    }
    expect(await noticesTo(owner.email, "Said No")).toBe(before + 1);
    expect(await prisma.auditEvent.count({ where: { action: ATTENDANCE_AUDIT.keptPaid, targetId: event.id } })).toBe(1);
  });

  it("opens one refund request, withdraws it on a Yes, and never opens another", async () => {
    const { event, ticket } = await paidEvent({ kind: "NONE" });
    const order = await buyPaid(event, ticket.id, "late-flip");
    const rsvp = order.rsvps[0]!;
    const token = await askAndToken(event, rsvp.id);
    await respondToAttendanceCheck({ token, response: "NOT_ATTENDING", note: "Flu" });
    const request = await prisma.refundRequest.findFirstOrThrow({ where: { orderId: order.id } });
    expect(request).toMatchObject({ status: RefundRequestStatus.OPEN, reason: expect.stringContaining("Flu") });
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: rsvp.id } })).toMatchObject({ refundRequestId: request.id, refundRequestOpenedAt: expect.any(Date) });

    // Coming after all: the open request is withdrawn, audited and announced.
    expect(await respondToAttendanceCheck({ token, response: "ATTENDING" })).toMatchObject({ ok: true, data: { response: "ATTENDING" } });
    expect(await prisma.refundRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: RefundRequestStatus.WITHDRAWN });
    expect(await prisma.auditEvent.count({ where: { action: "REFUND_REQUEST_WITHDRAWN", targetId: request.id } })).toBe(1);
    expect(await noticesTo(owner.email, "Coming after all")).toBe(1);

    // A later No never opens a second request; organisers are told once instead.
    const again = await respondToAttendanceCheck({ token, response: "NOT_ATTENDING" });
    expect(again).toMatchObject({ ok: true, data: { released: false, releaseFailed: expect.stringContaining("already been handled") } });
    await respondToAttendanceCheck({ token, response: "ATTENDING" });
    await respondToAttendanceCheck({ token, response: "NOT_ATTENDING" });
    expect(await prisma.refundRequest.count({ where: { orderId: order.id } })).toBe(1);
    expect(await noticesTo(owner.email, "Said No")).toBeGreaterThanOrEqual(1);
    const kept = await prisma.auditEvent.count({ where: { action: ATTENDANCE_AUDIT.keptPaid, targetId: event.id } });
    expect(kept).toBe(1);
  });

  it("leaves a decided request alone on a Yes and shows the answer beside it in Finance", async () => {
    const { event, ticket } = await paidEvent({ kind: "NONE" });
    const order = await buyPaid(event, ticket.id, "decided");
    const token = await askAndToken(event, order.rsvps[0]!.id);
    await respondToAttendanceCheck({ token, response: "NOT_ATTENDING" });
    const request = await prisma.refundRequest.findFirstOrThrow({ where: { orderId: order.id } });
    expect(await decideRefundRequest({ userId: owner.id, organisationId: paid.organisationId }, { requestId: request.id, decision: "decline", note: "No refunds this close" })).toEqual({ ok: true });
    await respondToAttendanceCheck({ token, response: "ATTENDING" });
    expect(await prisma.refundRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: RefundRequestStatus.DECLINED });
    const finance = await loadEventFinance(event.id, paid.organisationId);
    expect(finance?.refundRequests.find((row) => row.id === request.id)).toMatchObject({ attendanceAnswer: "ATTENDING" });
  });
});

describe("two windows answering at once", () => {
  it("runs one release and tells the other window what happened", async () => {
    const { event, ticket } = await paidEvent({ kind: "FULL_UNTIL", hours: 24 });
    const order = await buyPaid(event, ticket.id, "race", ["race-friend"]);
    const rsvp = order.rsvps.find((r) => r.guestEmail === email("race"))!;
    const token = await askAndToken(event, rsvp.id);
    const before = await noticesTo(owner.email, "Said No");
    const results = await Promise.all([respondToAttendanceCheck({ token, response: "NOT_ATTENDING" }), respondToAttendanceCheck({ token, response: "NOT_ATTENDING" })]);
    for (const result of results) expect(result).toMatchObject({ ok: true, data: { response: "NOT_ATTENDING", released: false, releaseFailed: expect.stringContaining("nothing was cancelled") } });
    expect(await noticesTo(owner.email, "Said No")).toBe(before + 1);
  });
});

describe("what the guest is told", () => {
  it("names the refund the policy gives, on the form and in the email", async () => {
    const { event, ticket } = await paidEvent({ kind: "PERCENT_UNTIL", hours: 24, percent: 50 });
    const order = await buyPaid(event, ticket.id, "amount");
    const rsvp = order.rsvps[0]!;
    const token = await askAndToken(event, rsvp.id);
    const view = await resolveAttendanceCheckByToken(token);
    expect(view).toMatchObject({ releaseKind: "paid", releaseRefund: expect.stringContaining("249.50") });
    await deliverAttendanceQueue([rsvp.id], deliverOutboxBatch);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: email("amount"), releaseKind: "paid", releaseRefund: view?.releaseRefund }));
  });
});
