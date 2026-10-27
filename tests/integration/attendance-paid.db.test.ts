import { EventStatus, OrderStatus, TeamTicketMode, PaymentRefundStatus, RefundRequestStatus, RsvpStatus, type RefundPolicyKind } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Attendance confirmation on paid tickets (docs/ATTENDANCE.md, docs/PAYMENTS.md).
 * A "No" with release on: a single-ticket order replied to by its buyer is
 * cancelled under the buyer refund policy (never a full refund by default);
 * once the policy has closed the place is kept and a refund request opened;
 * an order with several tickets, or a ticket somebody else paid for, is never
 * cancelled automatically and organisers are told.
 */

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/outboxWorker", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/outboxWorker")>()), startOutboxWorker: vi.fn() }));
vi.mock("@/lib/email/attendance", () => ({ sendAttendanceCheckEmail: mocks.send }));

import { prisma } from "@/lib/db";
import { ATTENDANCE_AUDIT, resolveAttendanceCheckByToken, respondToAttendanceCheck, sendAttendanceChecksForUser } from "@/lib/core/attendanceCheck";
import { settleOrderByHand } from "@/lib/payments/operations";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { deliverOutboxBatch } from "@/lib/outbox";
import { listAttendeesPage } from "@/lib/eventDashboard/attendees";
import { hashAttendanceToken } from "@/lib/attendanceToken";
import { createTeamEvent, paid, setUpPaidOrg, tearDownPaidOrg } from "./helpers/paidOrg";
import { deliverAttendanceQueue } from "./helpers/attendance";

const HOUR = 3_600_000;
let ownerId = "";
let ownerEmail = "";
let counter = 0;
const email = (name: string) => `${name}-${paid.suffix}@example.test`;

async function paidEvent(policy: { kind: RefundPolicyKind; hours?: number; percent?: number; }, release = true) {
  counter += 1;
  const start = new Date(Date.now() + 30 * 24 * HOUR);
  const event = await prisma.event.create({ data: {
    organisationId: paid.organisationId, title: `Paid attendance ${counter}`, slug: `paid-att-${paid.suffix}-${counter}`, currency: "INR", capacity: 50,
    startDateTime: start, endDateTime: new Date(start.getTime() + 2 * HOUR), timezone: "UTC", status: EventStatus.PUBLISHED, page: { create: { isPublished: true } },
    refundPolicyKind: policy.kind, refundPolicyHours: policy.hours ?? null, refundPolicyPercent: policy.percent ?? null, attendanceCheckReleaseOnDecline: release,
  } });
  const ticket = await prisma.ticketType.create({ data: { eventId: event.id, name: "General", priceMinor: BigInt(49900), payAtDesk: true } });
  return { event, ticket };
}

/** Buy at the desk and record the money as collected in person: a confirmed, paid order. */
async function buyPaid(event: { id: string; slug: string; }, ticketTypeId: string, buyer: string, friends: string[] = []) {
  const result = await submitRsvpCore({
    orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: email(buyer), name: "Paying Guest", answers: {}, payAtDesk: true,
    items: [{ ticketTypeId, quantity: 1 + friends.length }], attendees: friends.map((friend) => ({ name: "Friend", email: email(friend) })),
  }, { userId: null });
  expect(result).toMatchObject({ ok: true });
  const order = await prisma.order.findFirstOrThrow({ where: { eventId: event.id, buyerEmail: email(buyer) }, include: { rsvps: true } });
  await settleOrderByHand({ orderId: order.id, organisationId: paid.organisationId, actorUserId: ownerId, mode: "offline", method: "CASH" });
  return order;
}

async function askAndToken(event: { id: string; organisationId: string; }, rsvpId: string) {
  await sendAttendanceChecksForUser(ownerId, { organisationSlug: paid.orgSlug, eventId: event.id });
  const check = await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId } });
  const messages = await prisma.outboxMessage.findMany({ where: { kind: "attendance-check", payload: { path: ["rsvpId"], equals: rsvpId } } });
  return messages.map((message) => (message.payload as { token: string }).token).find((raw) => hashAttendanceToken(raw) === check.tokenHash)!;
}

const noticesTo = (to: string, subject: string) => prisma.outboxMessage.count({ where: { kind: "operator-notice", AND: [{ payload: { path: ["to"], equals: to } }, { payload: { path: ["subject"], string_contains: subject } }] } });

beforeAll(async () => {
  await setUpPaidOrg("Paid attendance");
  ownerEmail = email("owner");
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, name: "Owner", emailVerified: new Date(), memberships: { create: { organisationId: paid.organisationId, role: "OWNER" } } } })).id;
});
beforeEach(() => {
  mocks.send.mockReset();
  mocks.send.mockResolvedValue(undefined);
});
afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "OutboxMessage" WHERE "payload"->>'to' LIKE ${`%${paid.suffix}@example.test`}`;
  await prisma.user.deleteMany({ where: { email: { endsWith: `${paid.suffix}@example.test` } } });
  await tearDownPaidOrg();
});

describe("a paid single ticket replied to by its buyer", () => {
  it("is cancelled under the refund policy after the reply commits, refunding only what the policy allows", async () => {
    const { event, ticket } = await paidEvent({ kind: "PERCENT_UNTIL", hours: 24, percent: 50 });
    const order = await buyPaid(event, ticket.id, "single");
    const rsvp = order.rsvps[0]!;
    const token = await askAndToken(event, rsvp.id);
    expect((await resolveAttendanceCheckByToken(token))?.releaseKind).toBe("paid");
    await deliverAttendanceQueue([rsvp.id], deliverOutboxBatch);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: email("single"), releaseKind: "paid" }));

    expect(await respondToAttendanceCheck({ token, response: "NOT_ATTENDING", note: "Clash" })).toEqual({ ok: true, data: { response: "NOT_ATTENDING", released: true } });
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: { include: { refunds: true } } } });
    expect(after.status).toBe(OrderStatus.CANCELLED);
    // Half of 499.00, as the policy says; never everything by default.
    expect(after.payments[0]!.refunds).toEqual([expect.objectContaining({ amountMinor: BigInt(24950), status: PaymentRefundStatus.SUCCEEDED })]);
    expect(await prisma.rSVP.findUnique({ where: { id: rsvp.id } })).toBeNull();
    expect(await prisma.auditEvent.findFirst({ where: { action: ATTENDANCE_AUDIT.released, targetId: event.id } })).toMatchObject({ metadata: { rsvpId: rsvp.id, paid: true } });
  });
});

describe("once the refund policy has closed", () => {
  it("keeps the place, opens one refund request, and never promises a release", async () => {
    const { event, ticket } = await paidEvent({ kind: "NONE" });
    const order = await buyPaid(event, ticket.id, "late");
    const rsvp = order.rsvps[0]!;
    const token = await askAndToken(event, rsvp.id);
    expect((await resolveAttendanceCheckByToken(token))?.releaseKind).toBeNull();
    await deliverAttendanceQueue([rsvp.id], deliverOutboxBatch);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ releaseKind: null }));

    const reply = await respondToAttendanceCheck({ token, response: "NOT_ATTENDING", note: "Ill" });
    expect(reply).toMatchObject({ ok: true, data: { released: false, releaseFailed: expect.stringContaining("refund") } });
    expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: rsvp.id } })).status).toBe(RsvpStatus.CONFIRMED);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CONFIRMED);
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: rsvp.id } })).toMatchObject({ releaseOutcome: "refundRequested" });
    const requests = await prisma.refundRequest.findMany({ where: { orderId: order.id } });
    expect(requests).toEqual([expect.objectContaining({ status: RefundRequestStatus.OPEN, reason: expect.stringContaining("Ill") })]);
    expect(await noticesTo(ownerEmail, "Refund request")).toBe(1);

    // Changing to Yes and back to No never opens a second request.
    await respondToAttendanceCheck({ token, response: "ATTENDING" });
    expect(await respondToAttendanceCheck({ token, response: "NOT_ATTENDING" })).toMatchObject({ ok: true, data: { released: false } });
    expect(await prisma.refundRequest.count({ where: { orderId: order.id } })).toBe(1);
    const page = await listAttendeesPage({ kind: "event", eventId: event.id, organisationId: paid.organisationId }, { attendance: "notComing" }, { origin: "https://events.example.test", teamMode: false });
    expect(page.rows.map((row) => row.attendance)).toEqual([expect.objectContaining({ state: "notComing", outcome: "refundRequested" })]);
  });
});

describe("paid places organisers handle", () => {
  it("never cancels an order with several tickets, and tells organisers once per No", async () => {
    const { event, ticket } = await paidEvent({ kind: "FULL_UNTIL", hours: 24 });
    const order = await buyPaid(event, ticket.id, "group", ["friend"]);
    const buyerRsvp = order.rsvps.find((r) => r.guestEmail === email("group"))!;
    const friendRsvp = order.rsvps.find((r) => r.guestEmail === email("friend"))!;
    const token = await askAndToken(event, buyerRsvp.id);
    const friendToken = await askAndToken(event, friendRsvp.id);
    expect((await resolveAttendanceCheckByToken(token))?.releaseKind).toBeNull();

    const reply = await respondToAttendanceCheck({ token, response: "NOT_ATTENDING" });
    expect(reply).toMatchObject({ ok: true, data: { released: false, releaseFailed: expect.stringContaining("nothing was cancelled") } });
    expect(await respondToAttendanceCheck({ token: friendToken, response: "NOT_ATTENDING" })).toMatchObject({ ok: true, data: { released: false } });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CONFIRMED);
    expect(await prisma.rSVP.count({ where: { orderId: order.id, status: RsvpStatus.CONFIRMED } })).toBe(2);
    expect(await prisma.paymentRefund.count({ where: { payment: { orderId: order.id } } })).toBe(0);
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: buyerRsvp.id } })).toMatchObject({ releaseOutcome: "multiTicket" });
    expect(await noticesTo(ownerEmail, "Said No")).toBe(2);
    expect(await prisma.auditEvent.count({ where: { action: ATTENDANCE_AUDIT.keptPaid, targetId: event.id } })).toBe(2);

    // Saying No again doesn't repeat the notice.
    expect(await respondToAttendanceCheck({ token, response: "NOT_ATTENDING", note: "Still no" })).toMatchObject({ ok: true, data: { released: false } });
    expect(await noticesTo(ownerEmail, "Said No")).toBe(2);
  });

  it("never cancels a ticket somebody else paid for", async () => {
    const { event, ticket } = await paidEvent({ kind: "FULL_UNTIL", hours: 24 });
    const order = await buyPaid(event, ticket.id, "gifter");
    const rsvp = order.rsvps[0]!;
    // The ticket now belongs to someone other than the buyer (as after a transfer).
    await prisma.rSVP.update({ where: { id: rsvp.id }, data: { guestEmail: email("giftee"), attendeeKey: `guest:${email("giftee")}` } });
    const token = await askAndToken(event, rsvp.id);
    expect((await resolveAttendanceCheckByToken(token))?.releaseKind).toBeNull();
    expect(await respondToAttendanceCheck({ token, response: "NOT_ATTENDING" })).toMatchObject({ ok: true, data: { released: false } });
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: rsvp.id } })).toMatchObject({ releaseOutcome: "notBuyer" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CONFIRMED);
    expect(await noticesTo(ownerEmail, "Said No")).toBeGreaterThanOrEqual(3);
  });

  it("never cancels a team ticket that pays for the whole team when its leader says No", async () => {
    const { event, ticket } = await createTeamEvent({ mode: TeamTicketMode.PER_TEAM });
    await prisma.event.update({ where: { id: event.id }, data: { attendanceCheckReleaseOnDecline: true, refundPolicyKind: "FULL_UNTIL", refundPolicyHours: 24 } });
    await prisma.ticketType.update({ where: { id: ticket.id }, data: { payAtDesk: true } });
    const created = await submitRsvpCore({
      orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: email("team-lead"), name: "Team Lead", answers: {}, payAtDesk: true, items: [{ ticketTypeId: ticket.id, quantity: 1 }], attendees: [],
    }, { userId: null, team: { mode: "create", name: `Paid team ${paid.suffix}` } });
    expect(created).toMatchObject({ ok: true });
    const order = await prisma.order.findFirstOrThrow({ where: { eventId: event.id }, include: { rsvps: true } });
    await settleOrderByHand({ orderId: order.id, organisationId: paid.organisationId, actorUserId: ownerId, mode: "offline", method: "CASH" });
    const team = await prisma.team.findFirstOrThrow({ where: { eventId: event.id } });
    // A teammate joins free under the team ticket (PER_TEAM).
    await prisma.rSVP.create({ data: { eventId: event.id, teamId: team.id, guestEmail: email("team-mate"), attendeeKey: `guest:${email("team-mate")}`, status: RsvpStatus.CONFIRMED } });
    const leaderToken = await askAndToken(event, order.rsvps[0]!.id);
    expect(await respondToAttendanceCheck({ token: leaderToken, response: "NOT_ATTENDING" })).toMatchObject({ ok: true, data: { released: false } });
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: order.rsvps[0]!.id } })).toMatchObject({ releaseOutcome: "multiTicket" });
    expect(await prisma.rSVP.count({ where: { teamId: team.id } })).toBe(2);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CONFIRMED);
  });

  it("records a paid No without touching anything while release is off", async () => {
    const { event, ticket } = await paidEvent({ kind: "FULL_UNTIL", hours: 24 }, false);
    const order = await buyPaid(event, ticket.id, "off");
    const token = await askAndToken(event, order.rsvps[0]!.id);
    expect(await respondToAttendanceCheck({ token, response: "NOT_ATTENDING" })).toEqual({ ok: true, data: { response: "NOT_ATTENDING", released: false } });
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: order.rsvps[0]!.id } })).toMatchObject({ releaseOutcome: null });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CONFIRMED);
  });

  it("keeps a checked-in buyer's paid place with a failed release", async () => {
    const { event, ticket } = await paidEvent({ kind: "FULL_UNTIL", hours: 24 });
    const order = await buyPaid(event, ticket.id, "arrived");
    const rsvp = order.rsvps[0]!;
    const token = await askAndToken(event, rsvp.id);
    await prisma.rSVP.update({ where: { id: rsvp.id }, data: { checkedInAt: new Date() } });
    expect(await respondToAttendanceCheck({ token, response: "NOT_ATTENDING" })).toMatchObject({ ok: true, data: { released: false, releaseFailed: expect.stringContaining("checked in") } });
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: rsvp.id } })).toMatchObject({ releaseOutcome: "failed" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CONFIRMED);
  });
});
