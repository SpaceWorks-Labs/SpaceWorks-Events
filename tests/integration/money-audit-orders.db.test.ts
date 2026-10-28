import { AttendanceResponse, ExpenseCategory, ExpenseClaimKind, ExpenseClaimStatus, RefundRequestStatus, TeamTicketMode } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Money follow-ups (docs/PAYMENTS.md, docs/FINANCE.md, docs/ATTENDANCE.md):
 * a ticket still owed at the desk, or a PER_TEAM leader's team ticket, is
 * cancelled only as an order; a ticket with expense claims in play is never
 * transferred; a refused refund reopens its request only while the guest
 * still says No; and a buyer's own open request is the one an attendance
 * "No" records.
 */

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/outboxWorker", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/outboxWorker")>()), startOutboxWorker: vi.fn() }));
vi.mock("@/lib/email/attendance", () => ({ sendAttendanceCheckEmail: vi.fn() }));

import { prisma } from "@/lib/db";
import { transferOrderTicket } from "@/app/actions/orders";
import { respondToAttendanceCheck } from "@/lib/core/attendanceCheck";
import { settleOrderByHand } from "@/lib/payments/operations";
import { OpenClaimsError, transferTicket } from "@/lib/payments/transfers";
import { decideRefundRequest, requestRefund } from "@/lib/refundRequests";
import { cancelRegistrationByToken } from "@/lib/rsvpCancel";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { createTeamEvent, paid } from "./helpers/paidOrg";
import { askAndToken, buyAtDesk, buyPaid, email, owner, paidEvent, setUpPaidAttendance, tearDownPaidAttendance } from "./helpers/attendancePaid";

beforeAll(() => setUpPaidAttendance("Money audit orders"));
afterAll(() => tearDownPaidAttendance());

const PAID_ORDER = { ok: false, code: "PAID_ORDER" };

describe.sequential("cancelling a ticket that is owed or leads a paid team", () => {
  it("sends a desk reservation to its order instead of deleting the ticket", async () => {
    const { event, ticket } = await paidEvent({ kind: "FULL_UNTIL", hours: 24 });
    const order = await buyAtDesk(event, ticket.id, "owed");
    const rsvp = order.rsvps[0]!;
    expect(await cancelRegistrationByToken(null, rsvp.checkInToken)).toMatchObject(PAID_ORDER);
    expect(await prisma.rSVP.count({ where: { id: rsvp.id } })).toBe(1);
  });

  it("keeps a PER_TEAM leader's waived team ticket with its order and team", async () => {
    const { event, ticket } = await createTeamEvent({ mode: TeamTicketMode.PER_TEAM });
    await prisma.ticketType.update({ where: { id: ticket.id }, data: { payAtDesk: true } });
    const created = await submitRsvpCore(
      { orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: email("leader"), name: "Team Lead", answers: {}, payAtDesk: true, items: [{ ticketTypeId: ticket.id, quantity: 1 }] },
      { userId: null, team: { mode: "create", name: `Comets ${paid.suffix.slice(0, 6)}` } },
    );
    expect(created).toMatchObject({ ok: true });
    const order = await prisma.order.findFirstOrThrow({ where: { eventId: event.id }, include: { rsvps: true } });
    // Waived: nothing owed and nothing paid, but the order still pays for the whole team.
    expect(await settleOrderByHand({ orderId: order.id, organisationId: paid.organisationId, actorUserId: owner.id, mode: "waive" })).toBe("confirmed");
    expect(await cancelRegistrationByToken(null, order.rsvps[0]!.checkInToken)).toMatchObject(PAID_ORDER);
    expect(await prisma.team.count({ where: { eventId: event.id } })).toBe(1);
  });
});

describe.sequential("transfers and expense claims", () => {
  it("refuses to transfer a ticket while its holder's claims are waiting, approved or paid", async () => {
    const { event, ticket } = await paidEvent({ kind: "NONE" });
    await prisma.event.update({ where: { id: event.id }, data: { allowTransfers: true, transferCutoffHours: 1 } });
    const order = await buyPaid(event, ticket.id, "claimant");
    const rsvp = order.rsvps[0]!;
    const claim = await prisma.expenseClaim.create({ data: {
      organisationId: paid.organisationId, eventId: event.id, eventTitle: event.title, kind: ExpenseClaimKind.PARTICIPANT, rsvpId: rsvp.id,
      payeeName: "Claimant", payeeEmail: email("claimant"), category: ExpenseCategory.TRAVEL, description: "Train", amountMinor: BigInt(5000), currency: "INR",
    } });
    const input = { orderToken: order.accessToken, rsvpId: rsvp.id, name: "New Holder", email: email("new-holder") };
    for (const status of [ExpenseClaimStatus.SUBMITTED, ExpenseClaimStatus.APPROVED, ExpenseClaimStatus.PAID]) {
      await prisma.expenseClaim.update({ where: { id: claim.id }, data: { status, approvedMinor: status === ExpenseClaimStatus.SUBMITTED ? null : BigInt(5000) } });
      await expect(transferTicket(input)).rejects.toBeInstanceOf(OpenClaimsError);
    }
    // The web action and the app get the code.
    expect(await transferOrderTicket(input)).toMatchObject({ ok: false, code: "OPEN_CLAIMS" });
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: rsvp.id } })).toMatchObject({ guestEmail: email("claimant") });
    // A withdrawn claim no longer holds the ticket.
    await prisma.expenseClaim.update({ where: { id: claim.id }, data: { status: ExpenseClaimStatus.WITHDRAWN, approvedMinor: null } });
    expect(await transferTicket(input)).toEqual({ moved: 1 });
  });
});

describe.sequential("refund requests opened by an attendance No", () => {
  async function refusedApproval(label: string) {
    const { event, ticket } = await paidEvent({ kind: "NONE" });
    const order = await buyPaid(event, ticket.id, label);
    const rsvp = order.rsvps[0]!;
    await respondToAttendanceCheck({ token: await askAndToken(event, rsvp.id), response: "NOT_ATTENDING" });
    const request = await prisma.refundRequest.findFirstOrThrow({ where: { orderId: order.id } });
    // A checked-in ticket can't be cancelled, so the refund is refused.
    await prisma.rSVP.update({ where: { id: rsvp.id }, data: { checkedInAt: new Date() } });
    return { rsvp, request };
  }

  it("reopens a refused approval while the guest still says No", async () => {
    const { request } = await refusedApproval("still-no");
    expect(await decideRefundRequest({ userId: owner.id, organisationId: paid.organisationId }, { requestId: request.id, decision: "approve", cancelTickets: true })).toMatchObject({ ok: false });
    expect(await prisma.refundRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: RefundRequestStatus.OPEN, decidedByUserId: null });
  });

  it("withdraws a refused approval when the guest said Yes meanwhile", async () => {
    const { rsvp, request } = await refusedApproval("now-yes");
    // The Yes landed while the request was being approved, so it could not withdraw it then.
    await prisma.attendanceCheck.update({ where: { rsvpId: rsvp.id }, data: { response: AttendanceResponse.ATTENDING, releaseOutcome: null } });
    expect(await decideRefundRequest({ userId: owner.id, organisationId: paid.organisationId }, { requestId: request.id, decision: "approve", cancelTickets: true })).toMatchObject({ ok: false });
    expect(await prisma.refundRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: RefundRequestStatus.WITHDRAWN });
  });

  it("records the buyer's own open request when the guest answers No", async () => {
    const { event, ticket } = await paidEvent({ kind: "NONE" });
    const order = await buyPaid(event, ticket.id, "asked-first");
    expect(await requestRefund(order.accessToken, "Can't make it")).toEqual({ ok: true });
    const own = await prisma.refundRequest.findFirstOrThrow({ where: { orderId: order.id } });
    const rsvp = order.rsvps[0]!;
    expect(await respondToAttendanceCheck({ token: await askAndToken(event, rsvp.id), response: "NOT_ATTENDING" })).toMatchObject({ ok: true });
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: rsvp.id } })).toMatchObject({ refundRequestId: own.id, refundRequestOpenedAt: expect.any(Date), releaseOutcome: "refundRequested" });
    expect(await prisma.refundRequest.count({ where: { orderId: order.id } })).toBe(1);
  });
});
