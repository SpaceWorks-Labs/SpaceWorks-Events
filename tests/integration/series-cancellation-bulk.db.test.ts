import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userId: "", noticeRows: 0, noticeBatches: 0, dateUpdates: 0, failStatus: false }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: state.userId } }) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
// Measure actual database operations without retaining SQL arguments or capabilities.
vi.mock("@/lib/db", async (original) => {
  const actual = await original<typeof import("@/lib/db")>();
  const prisma = actual.prisma.$extends({ query: {
    outboxMessage: {
      create: ({ args, query }) => { state.noticeRows += 1; return query(args); },
      createMany: ({ args, query }) => { state.noticeBatches += 1; return query(args); },
    },
    eventInstance: {
      update: ({ args, query }) => { state.dateUpdates += 1; return query(args); },
      updateMany: ({ args, query }) => { state.dateUpdates += 1; return query(args); },
    },
    eventSeries: { update: ({ args, query }) => {
      if (state.failStatus && args.data.status === "CANCELLED") throw new Error("Injected series status failure");
      return query(args);
    } },
  } });
  return { ...actual, prisma };
});
// This suite covers the atomic marker/notice transaction. Existing paid-series
// tests exercise the per-order refunds that run only after this transaction.
vi.mock("@/lib/payments/occurrences", async (original) => ({
  ...await original<typeof import("@/lib/payments/occurrences")>(),
  cancelOccurrence: vi.fn(async () => ({ orders: 0, refunded: 0, failed: 0, notified: 0 })),
}));

import { prisma } from "@/lib/db";
import { updateEventSeriesMeta } from "@/app/actions/series";
import { lockSellable } from "@/lib/payments/targets";
import { newOrderReference } from "@/lib/payments/orders";
import { backendPid, waitForLockWait, whileLocked } from "./helpers/lockWait";

const suffix = randomUUID();
let orgId = "";
let seriesId = "";
let pastId = "";
let earlierCancelledId = "";
const dateIds = Array.from({ length: 48 }, () => randomUUID());
const orders = Array.from({ length: 100 }, () => randomUUID());
const now = new Date();
const DAY = 86_400_000;
beforeAll(async () => {
  orgId = (await prisma.organisation.create({ data: { name: "Bulk cancellation", slug: `bulk-cancel-${suffix}` }, select: { id: true } })).id;
  state.userId = (await prisma.user.create({ data: { email: `owner-${suffix}@example.test`, memberships: { create: { organisationId: orgId, role: "OWNER" } } }, select: { id: true } })).id;
  seriesId = (await prisma.eventSeries.create({ data: {
    organisationId: orgId, title: "Weekly workshop", slug: "workshop", timezone: "UTC", currency: "GBP", status: "PUBLISHED", recurrenceRule: "FREQ=WEEKLY;COUNT=50",
  }, select: { id: true } })).id;
  await prisma.eventInstance.createMany({ data: dateIds.map((id, index) => ({
    id, eventSeriesId: seriesId, startDateTime: new Date(now.getTime() + (index + 1) * 7 * DAY), endDateTime: new Date(now.getTime() + (index + 1) * 7 * DAY + 3_600_000),
  })) });
  pastId = (await prisma.eventInstance.create({ data: { eventSeriesId: seriesId, startDateTime: new Date(now.getTime() - 2 * DAY), endDateTime: new Date(now.getTime() - DAY) }, select: { id: true } })).id;
  earlierCancelledId = (await prisma.eventInstance.create({ data: { eventSeriesId: seriesId, startDateTime: new Date(now.getTime() + DAY), endDateTime: new Date(now.getTime() + 2 * DAY), cancelledAt: now }, select: { id: true } })).id;
  await prisma.order.createMany({ data: orders.map((id, index) => ({
    id, organisationId: orgId, eventSeriesId: seriesId, reference: newOrderReference(),
    buyerEmail: `pass-${index}-${suffix}@example.test`, buyerName: "Pass holder", status: "CONFIRMED", currency: "GBP", totalMinor: BigInt(48000),
  })) });
  await prisma.payment.createMany({ data: orders.map((orderId) => ({ organisationId: orgId, orderId, amountMinor: BigInt(48000), currency: "GBP", provider: "OFFLINE", status: "PAID_OFFLINE", offlineMethod: "CASH", description: "48-date pass", paidAt: now })) });
  await prisma.rSVP.createMany({ data: dateIds.flatMap((eventInstanceId) => orders.map((orderId, index) => ({
    eventInstanceId, orderId, attendeeKey: `pass-${index}`, guestEmail: `pass-${index}-${suffix}@example.test`, status: "CONFIRMED" as const,
  }))) });
  // Account email wins over a duplicate guest email; case/space duplicates and
  // an order still being paid for must each receive only one notice per date.
  await prisma.rSVP.create({ data: { eventInstanceId: dateIds[0], userId: state.userId, guestEmail: "unused@example.test", attendeeKey: "user" }, select: { id: true } });
  await prisma.rSVP.create({ data: { eventInstanceId: dateIds[0], guestEmail: ` PASS-0-${suffix}@example.test `, attendeeKey: "duplicate" }, select: { id: true } });
  await prisma.order.create({ data: {
    organisationId: orgId, eventSeriesId: seriesId, eventInstanceId: dateIds[0], reference: newOrderReference(), buyerEmail: `waiting-${suffix}@example.test`, buyerName: "Waiting buyer", currency: "GBP", totalMinor: BigInt(1000),
    holdExpiresAt: new Date(now.getTime() + 60_000), holdCapAt: new Date(now.getTime() + 120_000),
  }, select: { id: true } });
}, 60_000);
afterAll(async () => {
  await prisma.outboxMessage.deleteMany({ where: { payload: { path: ["organisationId"], equals: orgId } } });
  await prisma.organisation.delete({ where: { id: orgId } });
  await prisma.user.delete({ where: { id: state.userId } });
  await prisma.$disconnect();
});

const noticeWhere = () => ({ kind: "operator-notice", payload: { path: ["organisationId"], equals: orgId } });
const cancel = () => updateEventSeriesMeta({ organisationSlug: `bulk-cancel-${suffix}`, eventSeriesId: seriesId, title: "Weekly workshop", timezone: "UTC", privacyType: "PUBLIC", status: "CANCELLED" });

describe.sequential("bulk atomic series cancellation", () => {
  it("rolls back all markers and durable notices if the status update fails", async () => {
    state.failStatus = true;
    try { await expect(cancel()).rejects.toThrow("Injected series status failure"); }
    finally { state.failStatus = false; }
    expect(await prisma.eventSeries.count({ where: { id: seriesId, status: "PUBLISHED" } })).toBe(1);
    expect(await prisma.eventInstance.count({ where: { id: { in: dateIds }, cancelledAt: { not: null } } })).toBe(0);
    expect(await prisma.outboxMessage.count({ where: noticeWhere() })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { organisationId: orgId, action: "EVENT_INSTANCE_CANCELLED" } })).toBe(0);
  }, 60_000);

  it("marks 48 dates in one update, queues 4,802 notices in batches, and serialises a competing pass reservation", async () => {
    state.noticeRows = state.noticeBatches = state.dateUpdates = 0;
    let holderPid = 0;
    const [cancelled, sellable] = await whileLocked(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "EventInstance" WHERE "id" = ${dateIds[0]} FOR UPDATE`;
        holderPid = await backendPid(tx);
      },
      async () => {
        // Cancellation queues on the held date after taking the series lock.
        const cancellation = cancel();
        await waitForLockWait(holderPid);
        // whileLocked's observer sees both the cancellation and this reservation.
        const reservation = prisma.$transaction((tx) => lockSellable(tx, { passSeriesId: seriesId }, new Date()), { timeout: 60_000 });
        return Promise.all([cancellation, reservation]);
      },
      { waiters: 2, beforeRelease: async (tx) => {
        expect(await tx.eventSeries.count({ where: { id: seriesId, status: "PUBLISHED" } })).toBe(1);
        expect(await tx.eventInstance.count({ where: { id: { in: dateIds }, cancelledAt: { not: null } } })).toBe(0);
        expect(await tx.outboxMessage.count({ where: noticeWhere() })).toBe(0);
      } },
    );
    expect(cancelled).toEqual({ ok: true });
    expect(sellable?.open).toBe(false);
    expect(await prisma.eventInstance.count({ where: { id: { in: dateIds }, cancelledAt: { not: null } } })).toBe(48);
    expect(await prisma.eventInstance.count({ where: { id: pastId, cancelledAt: null } })).toBe(1);
    expect(await prisma.eventInstance.count({ where: { id: earlierCancelledId, cancelledAt: now } })).toBe(1);
    expect(await prisma.outboxMessage.count({ where: noticeWhere() })).toBe(4802);
    expect(state.noticeRows).toBe(0);
    expect(state.noticeBatches).toBe(48);
    expect(state.dateUpdates).toBe(1);
    expect(await prisma.auditEvent.count({ where: { organisationId: orgId, action: "EVENT_INSTANCE_CANCELLED" } })).toBe(48);
    expect(await cancel()).toEqual({ ok: true });
    expect(await prisma.outboxMessage.count({ where: noticeWhere() })).toBe(4802);
  }, 60_000);
});
