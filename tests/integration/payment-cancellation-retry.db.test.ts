import { randomUUID } from "node:crypto";
import { EventStatus, OrderStatus, PaymentRefundStatus, PaymentStatus } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ value: null as null | { user: { id: string }; authenticatedAt: number } }));
const interruption = vi.hoisted(() => ({ orderId: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => session.value }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/publicUrl", async (original) => ({
  ...await original<typeof import("@/lib/publicUrl")>(), getRequestOrigin: async () => "http://127.0.0.1:3999",
}));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/payments/operations", async (original) => {
  const actual = await original<typeof import("@/lib/payments/operations")>();
  return { ...actual, refundOrder: async (input: Parameters<typeof actual.refundOrder>[0]) => {
    if (input.orderId === interruption.orderId) {
      interruption.orderId = "";
      throw new Error("Simulated interruption before refund processing");
    }
    return actual.refundOrder(input);
  } };
});

import { prisma } from "@/lib/db";
import { cancelEvent } from "@/app/actions/event";
import { cancelSeriesDate } from "@/app/actions/series";
import { deleteOrganisation } from "@/app/actions/membership";
import { listRefundableOrders } from "@/lib/payments/operations";
import { loadSeriesManageView } from "@/lib/views/app__dashboard__orgSlug__series__seriesId__page";
import { newOrderReference } from "@/lib/payments/orders";
import { getOrgDashboard } from "@/lib/orgDashboard";
import { setUpPaymentAudit, tearDownPaymentAudit } from "./helpers/paymentAudit";
import { fulfilled, holdLocks, raceBehind } from "./helpers/locks";

const suffix = randomUUID();
const orgIds: string[] = [];
let counter = 0;
beforeAll(() => setUpPaymentAudit("Cancellation retry"));
afterEach(() => { interruption.orderId = ""; vi.useRealTimers(); });
afterAll(async () => {
  await prisma.organisation.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `${suffix}@example.test` } } });
  await tearDownPaymentAudit();
});

async function setup(series: boolean) {
  counter += 1;
  const org = await prisma.organisation.create({ data: { name: "Retry cancellation", slug: `retry-cancel-${counter}-${suffix}` } });
  orgIds.push(org.id);
  const owner = await prisma.user.create({ data: {
    email: `owner-${counter}-${suffix}@example.test`, emailVerified: new Date(),
    memberships: { create: { organisationId: org.id, role: "OWNER" } },
  }, select: { id: true } });
  session.value = { user: { id: owner.id }, authenticatedAt: Date.now() };
  const timing = { startDateTime: new Date(Date.now() + 86_400_000), endDateTime: new Date(Date.now() + 90_000_000) };
  const course = series ? await prisma.eventSeries.create({ data: {
    organisationId: org.id, title: "Course", slug: "course", currency: "GBP", timezone: "UTC",
    status: EventStatus.PUBLISHED, recurrenceRule: "FREQ=WEEKLY;COUNT=1",
  }, select: { id: true } }) : null;
  const date = course ? await prisma.eventInstance.create({ data: { eventSeriesId: course.id, ...timing }, select: { id: true } }) : null;
  const event = series ? null : await prisma.event.create({ data: {
    organisationId: org.id, title: "Event", slug: "event", currency: "GBP", timezone: "UTC", status: EventStatus.PUBLISHED, ...timing,
  }, select: { id: true } });
  const order = await prisma.order.create({ data: {
    organisationId: org.id, ...(event ? { eventId: event.id } : { eventSeriesId: course!.id, eventInstanceId: date!.id }),
    reference: newOrderReference(), buyerEmail: `buyer-${counter}-${suffix}@example.test`, buyerName: "Buyer",
    status: OrderStatus.CONFIRMED, currency: "GBP", subtotalMinor: BigInt(50000), totalMinor: BigInt(50000),
  }, select: { id: true } });
  const payment = await prisma.payment.create({ data: {
    organisationId: org.id, orderId: order.id, amountMinor: BigInt(50000), currency: "GBP", provider: "OFFLINE",
    status: PaymentStatus.PAID_OFFLINE, offlineMethod: "CASH", description: "Desk ticket", paidAt: new Date(),
  }, select: { id: true } });
  await prisma.rSVP.create({ data: {
    ...(event ? { eventId: event.id } : { eventInstanceId: date!.id }), orderId: order.id,
    guestEmail: `buyer-${counter}-${suffix}@example.test`, attendeeKey: `buyer-${counter}`,
  }, select: { id: true } });
  const cancel = () => event
    ? cancelEvent({ organisationSlug: org.slug, eventId: event.id })
    : cancelSeriesDate({ organisationSlug: org.slug, eventSeriesId: course!.id, instanceId: date!.id });
  const deleting = () => deleteOrganisation({ organisationSlug: org.slug });
  function afterEnd() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(timing.endDateTime.getTime() + 1));
    session.value!.authenticatedAt = Date.now();
  }
  return { org, course, date, event, order, payment, cancel, deleting, afterEnd };
}

describe.sequential("finishing cancellation refunds after the target ends", () => {
  it.each([true, false])("recovers an interrupted unchecked-in order exactly once and permits deletion (series: %s)", async (series) => {
    const s = await setup(series);
    interruption.orderId = s.order.id;
    await expect(s.cancel()).rejects.toThrow("Simulated interruption");
    // The real cancellation and its notices committed; no refund work ran.
    if (series) expect(await prisma.eventInstance.findUnique({ where: { id: s.date!.id }, select: { cancelledAt: true } })).toEqual({ cancelledAt: expect.any(Date) });
    else expect(await prisma.event.findUnique({ where: { id: s.event!.id }, select: { status: true } })).toEqual({ status: EventStatus.CANCELLED });
    expect(await prisma.paymentRefund.count({ where: { paymentId: s.payment.id } })).toBe(0);
    s.afterEnd();
    expect(await s.deleting()).toMatchObject({ ok: false, error: expect.stringContaining("money to refund") });
    expect(await listRefundableOrders(series ? { eventSeriesId: s.course!.id } : { eventId: s.event!.id }, s.org.id)).toEqual([]);
    if (series) {
      const view = await loadSeriesManageView({ params: Promise.resolve({ orgSlug: s.org.slug, seriesId: s.course!.id }) });
      expect(view.dates).toEqual([]);
      expect(view.pastCancelledDates).toEqual([expect.objectContaining({ id: s.date!.id, cancelled: true })]);
    } else {
      const input = { organisation: s.org, view: "past" as const, query: "", pages: 1, month: undefined };
      const dashboard = await getOrgDashboard({ ...input, canManage: true });
      expect(dashboard.events.rows).toEqual([expect.objectContaining({
        href: `/dashboard/${s.org.slug}/event/${s.event!.id}`, status: { label: "Cancelled", tone: "neutral" },
        publicPath: null, checkInHref: null, outcome: null,
      })]);
      expect((await getOrgDashboard({ ...input, canManage: false })).events.rows).toEqual([]);
    }
    expect(await s.cancel()).toMatchObject({ ok: true, data: { refunded: 1, failed: 0, notified: 0 } });
    expect(await s.cancel()).toMatchObject({ ok: true, data: { refunded: 0, failed: 0, notified: 0 } });
    expect(await prisma.paymentRefund.findMany({ where: { paymentId: s.payment.id }, select: { amountMinor: true, status: true } })).toEqual([
      { amountMinor: BigInt(50000), status: PaymentRefundStatus.SUCCEEDED },
    ]);
    expect(await prisma.order.findUnique({ where: { id: s.order.id }, select: { status: true } })).toEqual({ status: OrderStatus.CANCELLED });
    expect(await prisma.rSVP.count({ where: { orderId: s.order.id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { targetId: series ? s.date!.id : s.event!.id, action: series ? "EVENT_INSTANCE_CANCELLED" : "EVENT_CANCELLED" } })).toBe(1);
    expect(await s.deleting()).toEqual({ ok: true });
  });

  it("still refuses a first cancellation of an ended date", async () => {
    const s = await setup(true);
    s.afterEnd();
    expect(await s.cancel()).toEqual({ ok: false, error: "This date has already happened." });
    expect(await prisma.eventInstance.findUnique({ where: { id: s.date!.id }, select: { cancelledAt: true } })).toEqual({ cancelledAt: null });
    expect(await prisma.paymentRefund.count({ where: { paymentId: s.payment.id } })).toBe(0);
  });

  it("keeps cancelled dates reachable beyond the upcoming and report list limits", async () => {
    const s = await setup(true);
    const now = new Date();
    const extraDates = Array.from({ length: 31 }, (_, index) => ({
      id: randomUUID(), eventSeriesId: s.course!.id, cancelledAt: now,
      startDateTime: new Date(now.getTime() + (index + 2) * 86_400_000),
      endDateTime: new Date(now.getTime() + (index + 2) * 86_400_000 + 3_600_000),
    }));
    await prisma.eventInstance.createMany({ data: extraDates });
    const params = Promise.resolve({ orgSlug: s.org.slug, seriesId: s.course!.id });
    const upcomingView = await loadSeriesManageView({ params });
    expect(upcomingView.dates).toHaveLength(32);
    expect(upcomingView.dates.at(-1)).toMatchObject({ id: extraDates.at(-1)!.id, cancelled: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(extraDates.at(-1)!.endDateTime.getTime() + 1));
    const pastView = await loadSeriesManageView({ params });
    expect(pastView.dates).toEqual([]);
    expect(pastView.pastCancelledDates).toHaveLength(31);
    expect(pastView.pastCancelledDates.at(-1)).toMatchObject({ id: extraDates[0].id, cancelled: true });
  });

  it("serialises two post-end retries behind the series lock without returning money twice", async () => {
    const s = await setup(true);
    interruption.orderId = s.order.id;
    await expect(s.cancel()).rejects.toThrow("Simulated interruption");
    s.afterEnd();
    const blocker = await holdLocks(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${s.org.id} FOR KEY SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "EventSeries" WHERE "id" = ${s.course!.id} FOR UPDATE`;
    });
    const results = await raceBehind(blocker, s.cancel, s.cancel);
    for (const result of results) expect(fulfilled(result)).toMatchObject({ ok: true, data: { notified: 0 } });
    expect(await prisma.paymentRefund.findMany({ where: { paymentId: s.payment.id }, select: { amountMinor: true } })).toEqual([{ amountMinor: BigInt(50000) }]);
    expect(await s.deleting()).toEqual({ ok: true });
  });
});
