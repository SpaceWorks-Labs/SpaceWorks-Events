import { EventPrivacyType, EventStatus, OrderStatus, PaymentRefundStatus, PaymentStatus, RsvpStatus, SubmissionStatus, TeamTicketMode } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Cancelled targets (docs/PAYMENTS.md): a payment captured after its event,
 * series or date was cancelled is recorded and refunded in full, with no
 * ticket, team place or submitted project; settling by hand refuses; nobody
 * is promoted onto a cancelled event or date; and a request is only held
 * while its add-ons are still in stock.
 */

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));

import { prisma } from "@/lib/db";
import { submitSubmission } from "@/lib/core/judging";
import { cancelOccurrence } from "@/lib/payments/occurrences";
import { offerRequestedOrder, PaymentOperationError, settleOrderByHand } from "@/lib/payments/operations";
import { cancelRegistrationByToken } from "@/lib/rsvpCancel";
import { confirmRsvpWithinCapacity } from "@/lib/rsvpCapacity";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { createTeamEvent, paid, payOrder } from "./helpers/paidOrg";
import { buyOnline, email, freeRsvp, onlineEvent, onlineSeries, owner, paymentNotices, setUpPaymentAudit, tearDownPaymentAudit } from "./helpers/paymentAudit";

beforeAll(() => setUpPaymentAudit("Audit cancelled"));
afterAll(() => tearDownPaymentAudit());

const cancelEvent = (eventId: string) => prisma.event.update({ where: { id: eventId }, data: { status: EventStatus.CANCELLED } });

/** A late capture on a cancelled target: recorded, the order cancelled without tickets, refunded in full (pending), the buyer told. */
async function expectRefundedLateCapture(orderId: string) {
  expect(await payOrder(orderId)).toMatchObject({ outcome: "refunding", refundIds: [expect.any(String)] });
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { rsvps: true, payments: { include: { refunds: true } } } });
  expect(order.status).toBe(OrderStatus.CANCELLED);
  expect(order.rsvps).toHaveLength(0);
  const payment = order.payments.find((candidate) => candidate.status === PaymentStatus.PAID_ONLINE)!;
  expect(payment.refunds).toEqual([expect.objectContaining({ status: PaymentRefundStatus.PENDING, automatic: true, amountMinor: payment.amountMinor })]);
  expect(await paymentNotices(payment.id, "cancelled-refund")).toBe(1);
  expect(await paymentNotices(payment.id, "paid")).toBe(0);
  expect(await prisma.outboxMessage.count({ where: { kind: "rsvp-confirmation", payload: { path: ["to"], equals: order.buyerEmail } } })).toBe(0);
  expect(await prisma.auditEvent.count({ where: { action: "PAYMENT_CANCELLED_EVENT_REFUNDED", targetId: payment.id } })).toBe(1);
  return order;
}

describe.sequential("a payment captured after cancellation", () => {
  it("refunds an event ticket whose hold was still live when the event was cancelled", async () => {
    const { event, ticket } = await onlineEvent({ capacity: 5 });
    const order = await buyOnline({ eventSlug: event.slug }, ticket.id, "late-event");
    await cancelEvent(event.id);
    await expectRefundedLateCapture(order.id);
  });

  it("refunds a pass when one of its dates was cancelled before the payment landed", async () => {
    const { series, dates, pass } = await onlineSeries();
    const order = await buyOnline({ eventInstanceId: dates[0].id }, pass.id, "late-pass");
    expect(order.rsvps).toHaveLength(3);
    await cancelOccurrence({ organisationId: paid.organisationId, seriesId: series.id, instanceId: dates[1].id, actorUserId: owner.id, reason: "Venue closed" });
    await expectRefundedLateCapture(order.id);
  });

  it("refunds a team leader's order and places no team", async () => {
    const { event, ticket } = await createTeamEvent({ mode: TeamTicketMode.PER_TEAM, capacity: 3 });
    const created = await submitRsvpCore(
      { orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: email("late-leader"), name: "Team Lead", answers: {}, items: [{ ticketTypeId: ticket.id, quantity: 1 }] },
      { userId: null, team: { mode: "create", name: `Late ${paid.suffix.slice(0, 6)}` } },
    );
    expect(created).toMatchObject({ ok: true, data: { status: RsvpStatus.PENDING_PAYMENT } });
    const order = await prisma.order.findFirstOrThrow({ where: { eventId: event.id } });
    await cancelEvent(event.id);
    await expectRefundedLateCapture(order.id);
    expect(await prisma.team.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("refunds an entry fee and leaves the project a draft", async () => {
    const event = await prisma.event.create({ data: {
      organisationId: paid.organisationId, title: "Late hack", slug: `late-hack-${paid.suffix}`, currency: "INR", timezone: "UTC", status: EventStatus.PUBLISHED,
      startDateTime: new Date(Date.now() - 3_600_000), endDateTime: new Date(Date.now() + 48 * 3_600_000),
      submissionsEnabled: true, submissionsOpenAt: new Date(Date.now() - 3_600_000), submissionsCloseAt: new Date(Date.now() + 24 * 3_600_000), submissionFeeMinor: BigInt(15000),
      page: { create: { isPublished: true } },
    } });
    const user = await prisma.user.create({ data: { email: email("late-entrant"), name: "Entrant" } });
    const rsvp = await prisma.rSVP.create({ data: { eventId: event.id, userId: user.id, attendeeKey: `user:${user.id}`, status: RsvpStatus.CONFIRMED } });
    expect(await submitSubmission({ kind: "solo-owner", eventId: event.id, rsvpId: rsvp.id, userId: user.id }, { title: "Late rocket" })).toMatchObject({ ok: true });
    const submission = await prisma.submission.findFirstOrThrow({ where: { eventId: event.id } });
    const order = await prisma.order.findFirstOrThrow({ where: { submissionId: submission.id } });
    await cancelEvent(event.id);
    await expectRefundedLateCapture(order.id);
    expect(await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } })).toMatchObject({ status: SubmissionStatus.DRAFT });
  });

  it("refuses to settle a cancelled event's order by hand", async () => {
    const { event, ticket } = await onlineEvent();
    const order = await buyOnline({ eventSlug: event.slug }, ticket.id, "by-hand");
    await cancelEvent(event.id);
    await expect(settleOrderByHand({ orderId: order.id, organisationId: paid.organisationId, actorUserId: owner.id, mode: "offline", method: "CASH" })).rejects.toBeInstanceOf(PaymentOperationError);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: OrderStatus.PENDING });
    expect(await prisma.rSVP.count({ where: { orderId: order.id, status: RsvpStatus.CONFIRMED } })).toBe(0);
  });
});

describe.sequential("no promotion onto a cancelled event or date", () => {
  it("leaves a free event's waitlist alone when a guest cancels after the event was cancelled", async () => {
    const { event } = await onlineEvent({ capacity: 1, price: 0 });
    const going = await freeRsvp(event.id, "free-going", RsvpStatus.CONFIRMED);
    const waiting = await freeRsvp(event.id, "free-waiting", RsvpStatus.WAITLISTED);
    await cancelEvent(event.id);
    expect(await cancelRegistrationByToken(null, going.checkInToken)).toMatchObject({ ok: true });
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: RsvpStatus.WAITLISTED });
    // An organiser's promotion is refused too, whatever it asks for.
    expect(await confirmRsvpWithinCapacity({ rsvpId: waiting.id, eventId: event.id, expectedStatuses: [RsvpStatus.WAITLISTED] })).toBe("closed");
  });

  it("leaves a cancelled free date's waitlist alone", async () => {
    const series = await prisma.eventSeries.create({ data: { organisationId: paid.organisationId, title: "Free course", slug: `free-course-${paid.suffix}`, recurrenceRule: "FREQ=WEEKLY;COUNT=1", timezone: "UTC", status: EventStatus.PUBLISHED, capacity: 1 } });
    const date = await prisma.eventInstance.create({ data: { eventSeriesId: series.id, startDateTime: new Date(Date.now() + 86_400_000), endDateTime: new Date(Date.now() + 90_000_000) } });
    const going = await prisma.rSVP.create({ data: { eventInstanceId: date.id, guestEmail: email("date-going"), attendeeKey: `guest:${email("date-going")}`, status: RsvpStatus.CONFIRMED } });
    const waiting = await prisma.rSVP.create({ data: { eventInstanceId: date.id, guestEmail: email("date-waiting"), attendeeKey: `guest:${email("date-waiting")}`, status: RsvpStatus.WAITLISTED } });
    await prisma.eventInstance.update({ where: { id: date.id }, data: { cancelledAt: new Date() } });
    expect(await cancelRegistrationByToken(null, going.checkInToken)).toMatchObject({ ok: true });
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: RsvpStatus.WAITLISTED });
    expect(await confirmRsvpWithinCapacity({ rsvpId: waiting.id, eventInstanceId: date.id, expectedStatuses: [RsvpStatus.WAITLISTED] })).toBe("closed");
  });

  it("promotes no waitlisted unit on a cancelled team event", async () => {
    const { event } = await createTeamEvent({ capacity: 1 });
    const going = await freeRsvp(event.id, "unit-going", RsvpStatus.CONFIRMED);
    const waiting = await freeRsvp(event.id, "unit-waiting", RsvpStatus.WAITLISTED);
    await cancelEvent(event.id);
    expect(await cancelRegistrationByToken(null, going.checkInToken)).toMatchObject({ ok: true });
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: RsvpStatus.WAITLISTED });
  });
});

describe.sequential("add-on stock when a request is held", () => {
  it("refuses to approve a request whose extra sold out to another approved request", async () => {
    const { event, ticket } = await onlineEvent({ privacyType: EventPrivacyType.APPROVAL_REQUIRED });
    const lunch = await prisma.addOn.create({ data: { eventId: event.id, name: "Lunch", priceMinor: BigInt(20000), capacity: 1, maxPerOrder: 1 } });
    const first = await buyOnline({ eventSlug: event.slug }, ticket.id, "lunch-a", { addOns: [{ addOnId: lunch.id, quantity: 1 }] });
    const second = await buyOnline({ eventSlug: event.slug }, ticket.id, "lunch-b", { addOns: [{ addOnId: lunch.id, quantity: 1 }] });
    expect([first.status, second.status]).toEqual([OrderStatus.REQUESTED, OrderStatus.REQUESTED]);
    await offerRequestedOrder({ orderId: first.id, organisationId: paid.organisationId, actorUserId: owner.id });
    await expect(offerRequestedOrder({ orderId: second.id, organisationId: paid.organisationId, actorUserId: owner.id })).rejects.toThrow("Some extras on this order have sold out.");
    expect(await prisma.order.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: OrderStatus.REQUESTED });
    // Once the first hold ends unpaid, the extra is free again.
    await prisma.order.update({ where: { id: first.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    await offerRequestedOrder({ orderId: second.id, organisationId: paid.organisationId, actorUserId: owner.id });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: OrderStatus.PENDING });
  });
});
