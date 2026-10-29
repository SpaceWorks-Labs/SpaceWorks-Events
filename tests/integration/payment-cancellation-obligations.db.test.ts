import { randomUUID } from "node:crypto";
import { EventStatus, OrderStatus, PaymentRefundStatus, PaymentStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ value: null as null | { user: { id: string }; authenticatedAt: number } }));
const pause = vi.hoisted(() => ({ event: null as null | (() => Promise<void>), date: null as null | (() => Promise<void>) }));
vi.mock("@/lib/auth", () => ({ auth: async () => session.value }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/payments/eventCancellation", async (original) => {
  const actual = await original<typeof import("@/lib/payments/eventCancellation")>();
  return { ...actual, refundCancelledEvent: async (input: Parameters<typeof actual.refundCancelledEvent>[0]) => {
    await pause.event?.();
    return actual.refundCancelledEvent(input);
  } };
});
vi.mock("@/lib/payments/occurrences", async (original) => {
  const actual = await original<typeof import("@/lib/payments/occurrences")>();
  return { ...actual, cancelOccurrence: async (input: Parameters<typeof actual.cancelOccurrence>[0]) => {
    await pause.date?.();
    return actual.cancelOccurrence(input);
  } };
});

import { prisma } from "@/lib/db";
import { cancelEvent, deleteEvent } from "@/app/actions/event";
import { deleteOrganisation } from "@/app/actions/membership";
import { deleteEventSeries, updateEventSeriesMeta } from "@/app/actions/series";
import { refundEndedOrderAction } from "@/app/actions/payment-operations";
import { listRefundableOrders, refundOrder } from "@/lib/payments/operations";
import { cancelOccurrence } from "@/lib/payments/occurrences";
import { organisationMoneyBlocker } from "@/lib/payments/obligations";
import { newOrderReference } from "@/lib/payments/orders";
import { paid, payOrder } from "./helpers/paidOrg";
import { fulfilled, holdLocks, raceBehind } from "./helpers/locks";
import { buyOnline, onlineEvent, owner, setUpPaymentAudit, tearDownPaymentAudit } from "./helpers/paymentAudit";

const suffix = randomUUID();
const orgIds: string[] = [];
let counter = 0;
beforeAll(() => setUpPaymentAudit("Cancellation obligations"));
afterAll(async () => {
  await prisma.organisation.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `${suffix}@example.test` } } });
  await tearDownPaymentAudit();
});

async function setup(series = false) {
  counter += 1;
  const org = await prisma.organisation.create({ data: { name: "Cancellation test", slug: `cancel-deletion-${counter}-${suffix}` } });
  orgIds.push(org.id);
  const owner = await prisma.user.create({ data: { email: `owner-${counter}-${suffix}@example.test`, emailVerified: new Date(), memberships: { create: { organisationId: org.id, role: "OWNER" } } } });
  session.value = { user: { id: owner.id }, authenticatedAt: Date.now() };
  const event = series ? null : await prisma.event.create({ data: {
    organisationId: org.id, title: "Paid night", slug: "night", currency: "INR", timezone: "UTC", status: EventStatus.PUBLISHED,
    startDateTime: new Date(Date.now() + 86_400_000), endDateTime: new Date(Date.now() + 90_000_000),
  } });
  const course = series ? await prisma.eventSeries.create({ data: { organisationId: org.id, title: "Course", slug: "course", currency: "INR", timezone: "UTC", status: EventStatus.PUBLISHED, recurrenceRule: "FREQ=WEEKLY;COUNT=1" } }) : null;
  const date = course ? await prisma.eventInstance.create({ data: { eventSeriesId: course.id, startDateTime: new Date(Date.now() + 86_400_000), endDateTime: new Date(Date.now() + 90_000_000) } }) : null;
  const target = event ? { eventId: event.id } : { eventSeriesId: course!.id, eventInstanceId: date!.id };
  const order = await prisma.order.create({ data: {
    organisationId: org.id, ...target, reference: newOrderReference(), buyerEmail: `buyer-${counter}-${suffix}@example.test`, buyerName: "Buyer",
    status: OrderStatus.CONFIRMED, currency: "INR", subtotalMinor: BigInt(50000), totalMinor: BigInt(50000),
  }, select: { id: true } });
  const payment = await prisma.payment.create({ data: { organisationId: org.id, orderId: order.id, amountMinor: BigInt(50000), currency: "INR", provider: "OFFLINE", status: PaymentStatus.PAID_OFFLINE, offlineMethod: "CASH", description: "Desk ticket", paidAt: new Date() }, select: { id: true } });
  const rsvp = await prisma.rSVP.create({ data: { ...(event ? { eventId: event.id } : { eventInstanceId: date!.id }), orderId: order.id, guestEmail: `guest-${counter}-${suffix}@example.test`, attendeeKey: `guest-${counter}` }, select: { id: true } });
  const deleting = () => deleteOrganisation({ organisationSlug: org.slug });
  const refunding = () => refundEndedOrderAction({ organisationSlug: org.slug, ...(event ? { eventId: event.id } : { seriesId: course!.id }), orderId: order.id, amount: "", reason: "Cancellation: returned cash in person" });
  return { org, owner, event, course, date, order, payment, rsvp, deleting, refunding };
}

/** Pause after the cancellation commits, before refund processing takes any locks. */
function barrier() {
  let arrived!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release, wait: async () => { arrived(); await gate; } };
}

async function deletionBehindFence(s: Awaited<ReturnType<typeof setup>>) {
  const blocker = await holdLocks((tx) => tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${s.org.id} FOR UPDATE`);
  return fulfilled((await raceBehind(blocker, s.deleting))[0]);
}

async function assertGap(s: Awaited<ReturnType<typeof setup>>, kind: "event" | "date", cancel: () => Promise<unknown>) {
  const gate = barrier();
  pause[kind] = gate.wait;
  const cancelling = cancel();
  void cancelling.catch(() => {});
  try {
    await Promise.race([gate.ready, cancelling.then(() => { throw new Error("Cancellation returned before reaching the refund barrier."); })]);
    expect(await prisma.paymentRefund.count({ where: { paymentId: s.payment.id } })).toBe(0);
    if (kind === "event") expect(await prisma.event.findUnique({ where: { id: s.event!.id }, select: { status: true } })).toEqual({ status: EventStatus.CANCELLED });
    else expect(await prisma.eventSeries.findUnique({ where: { id: s.course!.id }, select: { status: true } })).toEqual({ status: EventStatus.CANCELLED });
    expect(await deletionBehindFence(s)).toMatchObject({ ok: false, error: expect.stringContaining("money to refund") });
    expect(await prisma.payment.count({ where: { id: s.payment.id } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { action: "ORGANISATION_DELETED", targetId: s.org.id } })).toBe(0);
  } finally {
    pause[kind] = null;
    gate.release();
    await cancelling.catch(() => {});
  }
  expect(await prisma.paymentRefund.findFirst({ where: { paymentId: s.payment.id }, select: { status: true } })).toEqual({ status: PaymentRefundStatus.SUCCEEDED });
  expect(await s.deleting()).toEqual({ ok: true });
}

describe.sequential("durable cancellation obligations before a refund exists", () => {
  it("refuses organisation deletion in the committed event cancellation / first refund gap", async () => {
    const s = await setup();
    await assertGap(s, "event", () => cancelEvent({ organisationSlug: s.org.slug, eventId: s.event!.id }));
  });

  it("refuses deletion after series cancellation commits but before any date is processed", async () => {
    const s = await setup(true);
    await assertGap(s, "date", () => updateEventSeriesMeta({ organisationSlug: s.org.slug, eventSeriesId: s.course!.id, title: "Course", timezone: "UTC", privacyType: "PUBLIC", status: EventStatus.CANCELLED }));
  });

  it.each(["series", "organisation"])("marks upcoming dates atomically and retains attended revenue as a series record for %s deletion", async (target) => {
    const s = await setup(true);
    const past = await prisma.eventInstance.create({ data: {
      eventSeriesId: s.course!.id, startDateTime: new Date(Date.now() - 90_000_000), endDateTime: new Date(Date.now() - 86_400_000),
    } });
    const earlier: string[] = [];
    // Both a date order and a pass covering only an earlier, attended date.
    for (const eventInstanceId of [past.id, null]) {
      const order = await prisma.order.create({ data: {
        organisationId: s.org.id, eventSeriesId: s.course!.id, eventInstanceId, reference: newOrderReference(),
        buyerEmail: "earlier@example.test", buyerName: "Earlier guest", status: OrderStatus.CONFIRMED,
        currency: "INR", subtotalMinor: BigInt(50000), totalMinor: BigInt(50000),
      }, select: { id: true } });
      earlier.push(order.id);
      await prisma.payment.create({ data: {
        organisationId: s.org.id, orderId: order.id, amountMinor: BigInt(50000), currency: "INR", provider: "OFFLINE",
        status: PaymentStatus.PAID_OFFLINE, offlineMethod: "CASH", description: "Earlier date", paidAt: new Date(),
      } });
      await prisma.rSVP.create({ data: {
        eventInstanceId: past.id, orderId: order.id, guestEmail: `earlier-${order.id}@example.test`,
        attendeeKey: `earlier-${order.id}`, checkedInAt: new Date(Date.now() - 88_000_000),
      } });
    }
    const gate = barrier();
    pause.date = gate.wait;
    const cancelling = updateEventSeriesMeta({ organisationSlug: s.org.slug, eventSeriesId: s.course!.id, title: "Course", timezone: "UTC", privacyType: "PUBLIC", status: EventStatus.CANCELLED });
    void cancelling.catch(() => {});
    try {
      await Promise.race([gate.ready, cancelling.then(() => { throw new Error("Missed the cancellation barrier."); })]);
      expect(await prisma.eventSeries.findUnique({ where: { id: s.course!.id }, select: { status: true } })).toEqual({ status: EventStatus.CANCELLED });
      expect(await prisma.eventInstance.findUnique({ where: { id: s.date!.id }, select: { cancelledAt: true } })).toEqual({ cancelledAt: expect.any(Date) });
      expect(await prisma.eventInstance.findUnique({ where: { id: past.id }, select: { cancelledAt: true } })).toEqual({ cancelledAt: null });
      expect(await prisma.paymentRefund.count({ where: { payment: { organisationId: s.org.id } } })).toBe(0);
      expect(await listRefundableOrders({ eventSeriesId: s.course!.id }, s.org.id)).toEqual([]);
      expect(await deletionBehindFence(s)).toMatchObject({ ok: false, error: expect.stringContaining("money to refund") });
      expect(await deleteEventSeries({ organisationSlug: s.org.slug, eventSeriesId: s.course!.id })).toMatchObject({ ok: false });
    } finally {
      pause.date = null;
      gate.release();
      await cancelling;
    }
    expect(await listRefundableOrders({ eventSeriesId: s.course!.id }, s.org.id)).toEqual([]);
    expect(await prisma.paymentRefund.count({ where: { payment: { orderId: { in: earlier } } } })).toBe(0);
    expect(await prisma.rSVP.count({ where: { orderId: { in: earlier }, checkedInAt: { not: null } } })).toBe(2);
    expect(await prisma.$transaction((tx) => organisationMoneyBlocker(tx, s.org.id, new Date()))).toBeNull();
    if (target === "series") expect(await deleteEventSeries({ organisationSlug: s.org.slug, eventSeriesId: s.course!.id })).toMatchObject({ ok: false, error: expect.stringContaining("earlier dates") });
    expect(await s.deleting()).toEqual({ ok: true });
  });

  it("keeps a checked-in cancelled event's obligation until the owner refunds it without removing the ticket", async () => {
    const s = await setup();
    const checkedInAt = new Date();
    await prisma.rSVP.update({ where: { id: s.rsvp.id }, data: { checkedInAt } });
    expect(await cancelEvent({ organisationSlug: s.org.slug, eventId: s.event!.id })).toMatchObject({ ok: true, data: { refunded: 0, failed: 1 } });
    expect(await prisma.paymentRefund.count({ where: { paymentId: s.payment.id } })).toBe(0);
    expect(await s.deleting()).toMatchObject({ ok: false, error: expect.stringContaining("money to refund") });
    expect((await listRefundableOrders({ eventId: s.event!.id }, s.org.id)).map((row) => row.id)).toEqual([s.order.id]);
    // An unresolved cancellation still blocks after its event has ended.
    expect(await prisma.$transaction((tx) => organisationMoneyBlocker(tx, s.org.id, new Date(Date.now() + 7 * 86_400_000)))).toContain("money to refund");
    const deletingEvent = () => deleteEvent({ organisationSlug: s.org.slug, eventId: s.event!.id });
    const pending = await prisma.paymentRefund.create({ data: { paymentId: s.payment.id, amountMinor: BigInt(50000), reason: "Cancellation" }, select: { id: true } });
    expect(await listRefundableOrders({ eventId: s.event!.id }, s.org.id)).toEqual([]);
    expect(await deletingEvent()).toMatchObject({ ok: false });
    expect(await s.deleting()).toMatchObject({ ok: false, error: expect.stringContaining("still on their way") });
    await prisma.paymentRefund.update({ where: { id: pending.id }, data: { status: PaymentRefundStatus.FAILED, settledAt: new Date() } });
    expect(await deletingEvent()).toMatchObject({ ok: false });
    expect(await s.refunding()).toEqual({ ok: true });
    expect(await prisma.paymentRefund.findFirst({ where: { paymentId: s.payment.id, status: PaymentRefundStatus.SUCCEEDED }, select: { status: true, offline: true, amountMinor: true } })).toEqual({ status: PaymentRefundStatus.SUCCEEDED, offline: true, amountMinor: BigInt(50000) });
    expect(await listRefundableOrders({ eventId: s.event!.id }, s.org.id)).toEqual([]);
    expect(await prisma.order.findUnique({ where: { id: s.order.id }, select: { status: true } })).toEqual({ status: OrderStatus.CONFIRMED });
    expect(await prisma.rSVP.findUnique({ where: { id: s.rsvp.id }, select: { checkedInAt: true } })).toEqual({ checkedInAt });
    expect(await deletingEvent()).toEqual({ ok: true });
    expect(await s.deleting()).toEqual({ ok: true });
  });

  it("returns an online checked-in order through the owner refund action and provider ledger", async () => {
    const { event, ticket } = await onlineEvent();
    const order = await buyOnline({ eventSlug: event.slug }, ticket.id, "checked-in-online");
    expect((await payOrder(order.id)).outcome).toBe("confirmed");
    const rsvp = await prisma.rSVP.findFirstOrThrow({ where: { orderId: order.id }, select: { id: true } });
    await prisma.rSVP.update({ where: { id: rsvp.id }, data: { checkedInAt: new Date() } });
    session.value = { user: { id: owner.id }, authenticatedAt: Date.now() };
    expect(await cancelEvent({ organisationSlug: paid.orgSlug, eventId: event.id })).toMatchObject({ ok: true, data: { failed: 1 } });
    expect(await prisma.paymentRefund.count({ where: { payment: { orderId: order.id } } })).toBe(0);
    expect(await deleteOrganisation({ organisationSlug: paid.orgSlug })).toMatchObject({ ok: false, error: expect.stringContaining("money to refund") });
    expect((await listRefundableOrders({ eventId: event.id }, paid.organisationId)).map((row) => row.id)).toEqual([order.id]);
    expect(await refundEndedOrderAction({ organisationSlug: paid.orgSlug, eventId: event.id, orderId: order.id, amount: "", reason: "Event cancelled" })).toEqual({ ok: true });
    expect(await prisma.paymentRefund.findFirst({ where: { payment: { orderId: order.id } }, select: { status: true, offline: true, amountMinor: true } })).toEqual({ status: PaymentRefundStatus.SUCCEEDED, offline: false, amountMinor: BigInt(49900) });
    expect(await prisma.rSVP.count({ where: { id: rsvp.id, checkedInAt: { not: null } } })).toBe(1);
    expect(await prisma.$transaction((tx) => organisationMoneyBlocker(tx, paid.organisationId, new Date()))).toBeNull();
    expect(await deleteEvent({ organisationSlug: paid.orgSlug, eventId: event.id })).toEqual({ ok: true });
  });

  it("keeps a checked-in cancelled pass date discoverable and refundable from the series page", async () => {
    const s = await setup(true);
    // A pass has no single date on the Order; its places tie it to dates.
    await prisma.order.update({ where: { id: s.order.id }, data: { eventInstanceId: null } });
    await prisma.rSVP.update({ where: { id: s.rsvp.id }, data: { checkedInAt: new Date() } });
    expect(await cancelOccurrence({ organisationId: s.org.id, seriesId: s.course!.id, instanceId: s.date!.id, actorUserId: s.owner.id, reason: "Venue shut" })).toMatchObject({ failed: 1 });
    expect(await s.deleting()).toMatchObject({ ok: false });
    expect((await listRefundableOrders({ eventSeriesId: s.course!.id }, s.org.id)).map((row) => row.id)).toEqual([s.order.id]);
    expect(await s.refunding()).toEqual({ ok: true });
    expect(await prisma.rSVP.count({ where: { id: s.rsvp.id, checkedInAt: { not: null } } })).toBe(1);
    expect(await listRefundableOrders({ eventSeriesId: s.course!.id }, s.org.id)).toEqual([]);
    expect(await deleteEventSeries({ organisationSlug: s.org.slug, eventSeriesId: s.course!.id })).toEqual({ ok: true });
    expect(await s.deleting()).toEqual({ ok: true });
  });

  it("retains a cancelled event while a refund is pending, including if it later fails", async () => {
    const s = await setup();
    await prisma.event.update({ where: { id: s.event!.id }, data: { status: EventStatus.CANCELLED } });
    await prisma.order.update({ where: { id: s.order.id }, data: { status: OrderStatus.CANCELLED } });
    await prisma.rSVP.deleteMany({ where: { orderId: s.order.id } });
    const refund = await prisma.paymentRefund.create({ data: { paymentId: s.payment.id, amountMinor: BigInt(50000), reason: "Cancellation" }, select: { id: true } });
    const deletingEvent = () => deleteEvent({ organisationSlug: s.org.slug, eventId: s.event!.id });
    expect(await deletingEvent()).toMatchObject({ ok: false });
    await prisma.paymentRefund.update({ where: { id: refund.id }, data: { status: PaymentRefundStatus.FAILED, settledAt: new Date() } });
    expect(await deletingEvent()).toMatchObject({ ok: false });
    expect(await s.refunding()).toEqual({ ok: true });
    expect(await deletingEvent()).toEqual({ ok: true });
    expect(await s.deleting()).toEqual({ ok: true });
  });

  it("keeps the cancelled event attached when an ended order has an unrecorded balance", async () => {
    const s = await setup();
    await refundOrder({ orderId: s.order.id, organisationId: s.org.id, actorUserId: s.owner.id, amountMinor: BigInt(10000), reason: "Partial cancellation", cancelTickets: true });
    await prisma.event.update({ where: { id: s.event!.id }, data: { status: EventStatus.CANCELLED } });
    expect(await deleteEvent({ organisationSlug: s.org.slug, eventId: s.event!.id })).toMatchObject({ ok: false });
    expect(await s.refunding()).toEqual({ ok: true });
    expect(await deleteEvent({ organisationSlug: s.org.slug, eventId: s.event!.id })).toEqual({ ok: true });
    expect(await s.deleting()).toEqual({ ok: true });
  });
});
