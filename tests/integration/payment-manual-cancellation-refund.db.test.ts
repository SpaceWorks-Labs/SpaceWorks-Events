import { EventStatus, OrderStatus, PaymentRefundStatus, PaymentStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ value: null as null | { user: { id: string }; authenticatedAt: number } }));
vi.mock("@/lib/auth", () => ({ auth: async () => session.value }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));

import { prisma } from "@/lib/db";
import { refundEndedOrderAction } from "@/app/actions/payment-operations";
import { listRefundableOrders } from "@/lib/payments/operations";
import { cancelOccurrence } from "@/lib/payments/occurrences";
import { organisationMoneyBlocker } from "@/lib/payments/obligations";
import { newOrderReference } from "@/lib/payments/orders";
import { paid } from "./helpers/paidOrg";
import { email, owner, setUpPaymentAudit, tearDownPaymentAudit } from "./helpers/paymentAudit";
import { whileLocked } from "./helpers/lockWait";

beforeAll(async () => {
  await setUpPaymentAudit("Manual cancellation refunds");
  session.value = { user: { id: owner.id }, authenticatedAt: Date.now() };
});
afterAll(() => tearDownPaymentAudit());

let counter = 0;
/** A £200 pass for two dates, paid in cash; select no bearer capabilities. */
async function passOrder() {
  counter += 1;
  const series = await prisma.eventSeries.create({ data: {
    organisationId: paid.organisationId, title: "Two-date course", slug: `manual-share-${counter}`,
    currency: "GBP", timezone: "UTC", status: EventStatus.PUBLISHED, recurrenceRule: "FREQ=WEEKLY;COUNT=2",
  }, select: { id: true } });
  const dates: Array<{ id: string }> = [];
  for (const offset of [7, 14]) {
    dates.push(await prisma.eventInstance.create({ data: {
      eventSeriesId: series.id, startDateTime: new Date(Date.now() + offset * 86_400_000),
      endDateTime: new Date(Date.now() + offset * 86_400_000 + 3_600_000),
    }, select: { id: true } }));
  }
  const order = await prisma.order.create({ data: {
    organisationId: paid.organisationId, eventSeriesId: series.id, reference: newOrderReference(),
    buyerEmail: email(`manual-share-${counter}`), buyerName: "Pass buyer", status: OrderStatus.CONFIRMED,
    currency: "GBP", subtotalMinor: BigInt(20000), totalMinor: BigInt(20000),
  }, select: { id: true } });
  const payment = await prisma.payment.create({ data: {
    organisationId: paid.organisationId, orderId: order.id, currency: "GBP", amountMinor: BigInt(20000),
    provider: "OFFLINE", status: PaymentStatus.PAID_OFFLINE, offlineMethod: "CASH", description: "Two-date pass", paidAt: new Date(),
  }, select: { id: true } });
  const rsvps: Array<{ id: string }> = [];
  for (const date of dates) {
    rsvps.push(await prisma.rSVP.create({ data: {
      eventInstanceId: date.id, orderId: order.id, guestEmail: email(`manual-share-${counter}`), attendeeKey: `buyer-${counter}`,
    }, select: { id: true } }));
  }
  const refund = (amount = "100") => refundEndedOrderAction({
    organisationSlug: paid.orgSlug, seriesId: series.id, orderId: order.id, amount, reason: "Cancelled date: cash returned",
  });
  const cancel = (index = 0) => cancelOccurrence({
    organisationId: paid.organisationId, seriesId: series.id, instanceId: dates[index].id, actorUserId: owner.id, reason: "Venue closed",
  });
  const list = () => listRefundableOrders({ eventSeriesId: series.id }, paid.organisationId);
  const total = async () => (await prisma.paymentRefund.aggregate({
    where: { paymentId: payment.id, status: { in: [PaymentRefundStatus.PENDING, PaymentRefundStatus.SUCCEEDED] } }, _sum: { amountMinor: true },
  }))._sum.amountMinor ?? BigInt(0);
  return { series, dates, order, payment, rsvps, refund, cancel, list, total };
}

describe.sequential("manual refunds cannot stack with automatic cancelled-date shares", () => {
  it("refuses a manual £100 refund waiting behind cancellation, then resumes with exactly £100 refunded", async () => {
    const s = await passOrder();
    // Cancellation owns Series first. The real manual action reaches that lock
    // before its marker commits, and automatic processing has not started yet.
    const manual = await whileLocked(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${paid.organisationId} FOR KEY SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "EventSeries" WHERE "id" = ${s.series.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "EventInstance" WHERE "id" = ${s.dates[0].id} FOR UPDATE`;
    }, () => s.refund(), { beforeRelease: (tx) => tx.eventInstance.update({ where: { id: s.dates[0].id }, data: { cancelledAt: new Date() } }) });
    const listed = await s.list();
    const blocker = await prisma.$transaction((tx) => organisationMoneyBlocker(tx, paid.organisationId, new Date(Date.now() + 30 * 86_400_000)));
    await s.cancel();
    await s.cancel();
    // Run the automatic path before asserting, so old code also demonstrates
    // its £150 total, rather than stopping at the incorrectly accepted action.
    expect({ manual, refunded: await s.total(), listed }).toMatchObject({
      manual: { ok: false, error: expect.stringContaining("automatic cancellation refund") }, refunded: BigInt(10000), listed: [],
    });
    expect(blocker).toContain("money to refund");
    expect(await prisma.rSVP.count({ where: { orderId: s.order.id, eventInstanceId: s.dates[0].id } })).toBe(0);
    expect(await prisma.rSVP.count({ where: { orderId: s.order.id, eventInstanceId: s.dates[1].id } })).toBe(1);
    expect(await s.list()).toEqual([]);
  });

  it("still lets an organiser refund a checked-in cancelled date by hand without another automatic share", async () => {
    const s = await passOrder();
    const checkedInAt = new Date();
    await prisma.rSVP.update({ where: { id: s.rsvps[0].id }, data: { checkedInAt } });
    expect(await s.cancel()).toMatchObject({ refunded: 0, failed: 1 });
    expect((await s.list()).map((row) => row.id)).toEqual([s.order.id]);
    expect(await s.refund()).toEqual({ ok: true });
    expect(await s.cancel()).toMatchObject({ refunded: 0, failed: 1 });
    expect(await s.total()).toBe(BigInt(10000));
    expect(await prisma.rSVP.findUnique({ where: { id: s.rsvps[0].id }, select: { checkedInAt: true } })).toEqual({ checkedInAt });
  });

  it("does not use a check-in on another date to expose an unchecked-in cancelled share", async () => {
    const s = await passOrder();
    await prisma.rSVP.update({ where: { id: s.rsvps[1].id }, data: { checkedInAt: new Date() } });
    await prisma.eventInstance.update({ where: { id: s.dates[0].id }, data: { cancelledAt: new Date() } });
    expect(await s.list()).toEqual([]);
    expect(await s.refund()).toMatchObject({ ok: false });
    await s.cancel();
    expect(await s.total()).toBe(BigInt(10000));
  });

  it("waits for every automatic cancelled-date share before allowing a checked-in share manually", async () => {
    const s = await passOrder();
    await prisma.rSVP.update({ where: { id: s.rsvps[0].id }, data: { checkedInAt: new Date() } });
    await prisma.eventInstance.updateMany({ where: { eventSeriesId: s.series.id }, data: { cancelledAt: new Date() } });
    expect(await s.list()).toEqual([]);
    expect(await s.refund()).toMatchObject({ ok: false });
    await s.cancel(1);
    expect(await s.total()).toBe(BigInt(10000));
    expect((await s.list()).map((row) => row.id)).toEqual([s.order.id]);
    expect(await s.refund()).toEqual({ ok: true });
    expect(await s.total()).toBe(BigInt(20000));
  });

  it("rechecks a check-in undone while the manual action waits on its registration lock", async () => {
    const s = await passOrder();
    await prisma.rSVP.update({ where: { id: s.rsvps[0].id }, data: { checkedInAt: new Date() } });
    await prisma.eventInstance.update({ where: { id: s.dates[0].id }, data: { cancelledAt: new Date() } });
    expect((await s.list()).map((row) => row.id)).toEqual([s.order.id]);
    const manual = await whileLocked(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "RSVP" WHERE "id" = ${s.rsvps[0].id} FOR UPDATE`;
      await tx.rSVP.update({ where: { id: s.rsvps[0].id }, data: { checkedInAt: null } });
    }, () => s.refund());
    expect(manual).toMatchObject({ ok: false });
    await s.cancel();
    expect(await s.total()).toBe(BigInt(10000));
  });
});
