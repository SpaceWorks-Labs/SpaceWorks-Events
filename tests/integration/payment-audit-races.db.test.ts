import { EventPrivacyType, EventStatus, OrderStatus, PaymentRefundStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Races on money and capacity (docs/PAYMENTS.md lock order): a pass date
 * cancelled twice refunds once; extending a hold can't oversell against a
 * new reservation; a scan and a cancellation never both win; and series
 * capacity counts live holds and the capacity a date would inherit.
 */

const session = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));

import { prisma } from "@/lib/db";
import { updateEventSeriesMeta } from "@/app/actions/series";
import { commitCheckInProjection } from "@/lib/checkInMutations";
import { startCheckout } from "@/lib/payments/checkout";
import { cancelOccurrence, setOccurrenceCapacity } from "@/lib/payments/occurrences";
import { cancelOrderAsBuyer, PaymentOperationError } from "@/lib/payments/operations";
import { seatTakingWhere } from "@/lib/payments/holds";
import { cancelRegistrationByToken } from "@/lib/rsvpCancel";
import { fake, paid, payOrder } from "./helpers/paidOrg";
import { buyOnline, freeRsvp, onlineEvent, onlineSeries, owner, setUpPaymentAudit, tearDownPaymentAudit, whileLocked } from "./helpers/paymentAudit";
import { backendPid, waitForLockWait } from "./helpers/lockWait";
import { holdNextTransaction } from "./helpers/transactionBarrier";

beforeAll(() => setUpPaymentAudit("Audit races"));
afterAll(() => tearDownPaymentAudit());

const lockRow = (table: "Order" | "RSVP" | "Event", id: string) => (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => (
  table === "Order" ? tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`
    : table === "RSVP" ? tx.$queryRaw`SELECT "id" FROM "RSVP" WHERE "id" = ${id} FOR UPDATE`
      : tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${id} FOR UPDATE`
);

async function paidPass() {
  const fixture = await onlineSeries();
  const order = await buyOnline({ eventInstanceId: fixture.dates[0].id }, fixture.pass.id, `pass-${Math.random().toString(36).slice(2, 8)}`);
  expect((await payOrder(order.id)).outcome).toBe("confirmed");
  return { ...fixture, order };
}

const committedRefunds = (orderId: string) => prisma.paymentRefund.findMany({ where: { payment: { orderId }, status: { in: [PaymentRefundStatus.PENDING, PaymentRefundStatus.SUCCEEDED] } } });

describe.sequential("cancelling a pass date", () => {
  it("refunds the date's share once when two cancellations race", async () => {
    const { series, dates, order } = await paidPass();
    const cancel = () => cancelOccurrence({ organisationId: paid.organisationId, seriesId: series.id, instanceId: dates[1].id, actorUserId: owner.id, reason: "Storm" });
    await whileLocked(lockRow("Order", order.id), () => Promise.all([cancel(), cancel()]), { waiters: 2 });
    expect((await committedRefunds(order.id)).map((refund) => refund.amountMinor)).toEqual([BigInt(30000)]);
    expect(await prisma.rSVP.count({ where: { orderId: order.id, eventInstanceId: dates[1].id } })).toBe(0);
    expect(await prisma.rSVP.count({ where: { orderId: order.id } })).toBe(2);
  });

  it("never refunds again when retried after the provider call was lost", async () => {
    const { series, dates, order } = await paidPass();
    fake.dropNext();
    const cancel = () => cancelOccurrence({ organisationId: paid.organisationId, seriesId: series.id, instanceId: dates[2].id, actorUserId: owner.id, reason: "Retry" });
    await cancel();
    expect(await committedRefunds(order.id)).toEqual([expect.objectContaining({ status: PaymentRefundStatus.PENDING, externalRefundId: null })]);
    await cancel();
    expect(await committedRefunds(order.id)).toHaveLength(1);
  });

  it("refuses a date someone on the pass has checked in to, refunding nothing", async () => {
    const { series, dates, order } = await paidPass();
    const onDate = order.rsvps.find((rsvp) => rsvp.eventInstanceId === dates[0].id)!;
    await prisma.rSVP.update({ where: { id: onDate.id }, data: { checkedInAt: new Date() } });
    expect(await cancelOccurrence({ organisationId: paid.organisationId, seriesId: series.id, instanceId: dates[0].id, actorUserId: owner.id, reason: "Late" })).toMatchObject({ refunded: 0, failed: 1 });
    expect(await committedRefunds(order.id)).toHaveLength(0);
    expect(await prisma.rSVP.count({ where: { orderId: order.id } })).toBe(3);
  });
});

describe.sequential("extending a hold", () => {
  it("never leaves two live holds on the last place when an extension races a new reservation", async () => {
    const { event, ticket } = await onlineEvent({ capacity: 1 });
    const first = await buyOnline({ eventSlug: event.slug }, ticket.id, "extend-a");
    // A's hold ends a moment from now, and its page can't be reused.
    const ends = new Date(Date.now() + 60_000);
    await prisma.order.update({ where: { id: first.id }, data: { holdExpiresAt: ends } });
    await prisma.rSVP.updateMany({ where: { orderId: first.id }, data: { holdExpiresAt: ends } });
    await prisma.paymentCheckoutAttempt.updateMany({ where: { payment: { orderId: first.id } }, data: { expiresAt: new Date() } });
    // A reaches Event while its hold is live; B starts only after it expires.
    let reserving!: ReturnType<typeof buyOnline>;
    const extended = await whileLocked(lockRow("Event", event.id), () => startCheckout(first.id), { beforeRelease: async (tx) => {
      const expired = new Date(Date.now() - 1);
      await tx.order.update({ where: { id: first.id }, data: { holdExpiresAt: expired } });
      await tx.rSVP.updateMany({ where: { orderId: first.id }, data: { holdExpiresAt: expired } });
      reserving = buyOnline({ eventSlug: event.slug }, ticket.id, "extend-b");
      await waitForLockWait(await backendPid(tx), 2);
    } });
    const second = await reserving;
    expect(extended).toEqual({ error: "hold_ended" });
    expect(second.status).toBe(OrderStatus.PENDING);
    expect(await prisma.rSVP.count({ where: { eventId: event.id, ...seatTakingWhere(new Date()) } })).toBe(1);
  });
});

/** The real scan writes first; cancellation reaches its lock before the scan commits. */
async function scanThenCancel<T>(rsvpId: string, cancel: () => Promise<T>) {
  const barrier = holdNextTransaction();
  const scan = commitCheckInProjection({ rsvpId, actorUserId: owner.id, source: "online", checkedInAt: new Date(), force: false });
  void scan.catch(() => {});
  let cancelling!: Promise<T>;
  try {
    const pid = await barrier.entered;
    cancelling = cancel();
    void cancelling.catch(() => {});
    await waitForLockWait(pid);
  } finally {
    barrier.release();
    barrier.restore();
  }
  expect(await scan).toMatchObject({ state: "checked-in" });
  return cancelling;
}

describe.sequential("a scan racing a cancellation", () => {
  it("refuses the paid cancellation waiting behind a committed scan", async () => {
    const { event, ticket } = await onlineEvent();
    await prisma.event.update({ where: { id: event.id }, data: { refundPolicyKind: "FULL_UNTIL", refundPolicyHours: 1 } });
    const order = await buyOnline({ eventSlug: event.slug }, ticket.id, "scan-paid");
    expect((await payOrder(order.id)).outcome).toBe("confirmed");
    const rsvp = order.rsvps[0]!;
    const cancel = await scanThenCancel(rsvp.id, () => cancelOrderAsBuyer({ orderId: order.id }).then(() => null, (error: unknown) => error));
    expect(cancel).toBeInstanceOf(PaymentOperationError);
    expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: rsvp.id } })).checkedInAt).not.toBeNull();
    expect(await committedRefunds(order.id)).toHaveLength(0);
  });

  it("does the same for a free guest's own cancellation", async () => {
    const { event } = await onlineEvent({ price: 0 });
    const rsvp = await freeRsvp(event.id, "scan-free", RsvpStatus.CONFIRMED);
    const cancel = await scanThenCancel(rsvp.id, () => cancelRegistrationByToken(null, rsvp.checkInToken));
    expect(cancel.ok).toBe(false);
    expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: rsvp.id } })).checkedInAt).not.toBeNull();
  });
});

describe.sequential("series capacity", () => {
  it("refuses a series capacity below a date's confirmed and held places", async () => {
    const { series, dates, single } = await onlineSeries({ capacity: 10 });
    await buyOnline({ eventInstanceId: dates[0].id }, single.id, "held-a", { quantity: 2 });
    session.userId = owner.id;
    const input = { organisationSlug: paid.orgSlug, eventSeriesId: series.id, title: series.title, description: "", timezone: "UTC", status: EventStatus.PUBLISHED, privacyType: EventPrivacyType.PUBLIC };
    expect(await updateEventSeriesMeta({ ...input, capacity: 1 })).toMatchObject({ ok: false });
    expect(await prisma.eventSeries.findUniqueOrThrow({ where: { id: series.id } })).toMatchObject({ capacity: 10 });
    expect(await updateEventSeriesMeta({ ...input, capacity: 2 })).toMatchObject({ ok: true });
    session.userId = "";
  });

  it("checks the inherited capacity before clearing a date's own", async () => {
    const { series, dates, single } = await onlineSeries({ capacity: 1 });
    await setOccurrenceCapacity({ organisationId: paid.organisationId, seriesId: series.id, instanceId: dates[0].id, capacity: 3, actorUserId: owner.id });
    await buyOnline({ eventInstanceId: dates[0].id }, single.id, "override", { quantity: 2 });
    await expect(setOccurrenceCapacity({ organisationId: paid.organisationId, seriesId: series.id, instanceId: dates[0].id, capacity: null, actorUserId: owner.id })).rejects.toBeInstanceOf(PaymentOperationError);
    expect(await prisma.eventInstance.findUniqueOrThrow({ where: { id: dates[0].id } })).toMatchObject({ capacity: 3 });
    await prisma.eventSeries.update({ where: { id: series.id }, data: { capacity: 2 } });
    await setOccurrenceCapacity({ organisationId: paid.organisationId, seriesId: series.id, instanceId: dates[0].id, capacity: null, actorUserId: owner.id });
    expect(await prisma.eventInstance.findUniqueOrThrow({ where: { id: dates[0].id } })).toMatchObject({ capacity: null });
  });
});
