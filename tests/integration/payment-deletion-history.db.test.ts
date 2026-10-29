import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: session.id }, authenticatedAt: Date.now() }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));

import { prisma } from "@/lib/db";
import { deleteEvent } from "@/app/actions/event";
import { deleteEventSeries } from "@/app/actions/series";
import { hasPaidOrders } from "@/lib/payments/eventCancellation";
import { organisationMoneyBlocker } from "@/lib/payments/obligations";
import { listFailedRefunds, listRefundableOrders } from "@/lib/payments/operations";
import { newOrderReference } from "@/lib/payments/orders";
import { loadReceipt } from "@/lib/payments/receipts";
import { loadOrganisationRevenue } from "@/lib/payments/revenue";
import { fenceOrganisation } from "@/lib/payments/targets";
import { whileLocked } from "./helpers/lockWait";

const suffix = randomUUID();
let org: { id: string; slug: string };
let counter = 0;
beforeAll(async () => {
  org = await prisma.organisation.create({ data: { name: "Deletion history", slug: `deletion-history-${suffix}` }, select: { id: true, slug: true } });
  const owner = await prisma.user.create({ data: { email: `owner-${suffix}@example.test`, memberships: { create: { organisationId: org.id, role: "OWNER" } } }, select: { id: true } });
  session.id = owner.id;
});
afterAll(async () => {
  await prisma.outboxMessage.deleteMany({ where: { payload: { path: ["organisationId"], equals: org.id } } });
  await prisma.organisation.delete({ where: { id: org.id } });
  await prisma.user.delete({ where: { id: session.id } });
  await prisma.$disconnect();
});

async function setup(kind: "event" | "date" | "pass", status: "PUBLISHED" | "CANCELLED" = "CANCELLED", online = false) {
  counter += 1;
  const times = { startDateTime: new Date(Date.now() - 90_000_000), endDateTime: new Date(Date.now() - 86_400_000) };
  const details = { organisationId: org.id, title: "Attended workshop", slug: `history-${counter}`, timezone: "UTC", currency: "GBP" };
  const event = kind === "event" ? await prisma.event.create({ data: { ...details, ...times, status }, select: { id: true } }) : null;
  const series = kind !== "event" ? await prisma.eventSeries.create({ data: { ...details, recurrenceRule: "FREQ=WEEKLY;COUNT=1", status }, select: { id: true } }) : null;
  const date = series ? await prisma.eventInstance.create({ data: { eventSeriesId: series.id, ...times }, select: { id: true } }) : null;
  const owner = event ? { eventId: event.id } : { eventSeriesId: series!.id };
  const order = await prisma.order.create({ data: {
    organisationId: org.id, ...owner, ...(kind === "date" ? { eventInstanceId: date!.id } : {}),
    reference: newOrderReference(), buyerEmail: `buyer-${counter}-${suffix}@example.test`, buyerName: "Buyer",
    status: "CONFIRMED", currency: "GBP", totalMinor: BigInt(10000), subtotalMinor: BigInt(10000),
  }, select: { id: true } });
  const payment = await prisma.payment.create({ data: {
    organisationId: org.id, orderId: order.id, amountMinor: BigInt(10000), currency: "GBP",
    ...(online ? { provider: "RAZORPAY", status: "PAID_ONLINE", externalPaymentId: `pay_${order.id}` } as const
      : { provider: "OFFLINE", status: "PAID_OFFLINE", offlineMethod: "CASH" } as const),
    description: "Workshop", paidAt: new Date(),
  }, select: { id: true } });
  await prisma.rSVP.create({ data: {
    ...(event ? { eventId: event.id } : { eventInstanceId: date!.id }), orderId: order.id,
    guestEmail: `buyer-${counter}-${suffix}@example.test`, attendeeKey: `buyer-${counter}`, checkedInAt: times.startDateTime,
  }, select: { id: true } });
  const remove = () => event
    ? deleteEvent({ organisationSlug: org.slug, eventId: event.id })
    : deleteEventSeries({ organisationSlug: org.slug, eventSeriesId: series!.id });
  return { owner, order, payment, remove };
}

describe.sequential("retained payments and deletion history", () => {
  it("ignores a successfully retried historical refund as an obligation independently of retained revenue", async () => {
    const s = await setup("date", "CANCELLED", true);
    const failed = await prisma.paymentRefund.create({ data: { paymentId: s.payment.id, amountMinor: BigInt(2000), status: "FAILED" }, select: { id: true } });
    expect(await prisma.$transaction((tx) => organisationMoneyBlocker(tx, org.id, new Date()))).toContain("refunds failed");
    const retry = await prisma.paymentRefund.create({ data: { paymentId: s.payment.id, amountMinor: BigInt(2000), retryOfRefundId: failed.id }, select: { id: true } });
    expect(await listFailedRefunds(s.owner, org.id)).toEqual([]);
    expect(await hasPaidOrders(s.owner)).toBe(true);
    expect(await prisma.$transaction((tx) => organisationMoneyBlocker(tx, org.id, new Date()))).toContain("still on their way");
    await prisma.paymentRefund.update({ where: { id: retry.id }, data: { status: "FAILED" }, select: { id: true } });
    expect((await listFailedRefunds(s.owner, org.id)).map((row) => row.id)).toEqual([retry.id]);
    expect(await prisma.$transaction((tx) => organisationMoneyBlocker(tx, org.id, new Date()))).toContain("refunds failed");
    await prisma.paymentRefund.create({ data: { paymentId: s.payment.id, amountMinor: BigInt(2000), status: "SUCCEEDED", retryOfRefundId: retry.id }, select: { id: true } });
    expect(await listFailedRefunds(s.owner, org.id)).toEqual([]);
    expect(await listRefundableOrders(s.owner, org.id)).toEqual([]);
    expect(await prisma.$transaction((tx) => organisationMoneyBlocker(tx, org.id, new Date()))).toBeNull();
    // The resolved chain is no longer owed; the retained £80 independently
    // keeps the organiser's ledger attached under the deletion policy.
    expect(await hasPaidOrders(s.owner)).toBe(true);
    await prisma.paymentRefund.create({ data: { paymentId: s.payment.id, amountMinor: BigInt(8000), status: "SUCCEEDED" }, select: { id: true } });
    expect(await hasPaidOrders(s.owner)).toBe(false);
  });

  it.each(["event", "date", "pass"] as const)("keeps the %s and organiser access while attended payments remain", async (kind) => {
    const s = await setup(kind);
    expect(await s.remove()).toMatchObject({ ok: false });
    expect(await prisma.order.count({ where: { id: s.order.id, ...s.owner } })).toBe(1);
  });

  it.each(["event", "date", "pass"] as const)("keeps pending and un-retried failed refunds attached, then preserves the fully refunded %s ledger on deletion", async (kind) => {
    // Fully refunded CONFIRMED orders allow deletion even without cancellation.
    const s = await setup(kind, "PUBLISHED");
    const refund = await prisma.paymentRefund.create({ data: { paymentId: s.payment.id, amountMinor: BigInt(10000) }, select: { id: true } });
    expect(await hasPaidOrders(s.owner)).toBe(true);
    expect(await s.remove()).toMatchObject({ ok: false });
    await prisma.paymentRefund.update({ where: { id: refund.id }, data: { status: "FAILED" }, select: { id: true } });
    expect(await s.remove()).toMatchObject({ ok: false });
    await prisma.paymentRefund.create({ data: { paymentId: s.payment.id, amountMinor: BigInt(10000), status: "SUCCEEDED", retryOfRefundId: refund.id }, select: { id: true } });
    expect(await hasPaidOrders(s.owner)).toBe(false);
    expect(await s.remove()).toEqual({ ok: true });
    expect(await prisma.order.findUnique({ where: { id: s.order.id }, select: { eventId: true, eventSeriesId: true, eventInstanceId: true } })).toEqual({ eventId: null, eventSeriesId: null, eventInstanceId: null });
    expect(await prisma.paymentRefund.count({ where: { paymentId: s.payment.id } })).toBe(2);
    // Deletion retains organisation totals and the buyer receipt, without its target context.
    const access = await prisma.order.findUniqueOrThrow({ where: { id: s.order.id }, select: { accessToken: true } });
    const receipt = await loadReceipt(access.accessToken);
    expect(receipt?.paidMinor).toBe(BigInt(10000));
    expect(receipt?.refundedMinor).toBe(BigInt(10000));
    expect(receipt?.event).toBeNull();
    const totals = await loadOrganisationRevenue(org.id, { since: new Date(0), timeZone: "UTC" });
    expect(totals.find((row) => row.currency === "GBP")!.summary.refundedMinor).toBeGreaterThanOrEqual(10000);
  });

  it.each(["CONFIRMED", "CANCELLED", "EXPIRED"] as const)("keeps collected money on a %s order independently of its total or target cancellation", async (status) => {
    const s = await setup("date");
    await prisma.order.update({ where: { id: s.order.id }, data: { status, totalMinor: BigInt(0), subtotalMinor: BigInt(0) }, select: { id: true } });
    expect(await s.remove()).toMatchObject({ ok: false });
  });

  it("rechecks retained historical revenue committed while deletion waits for the series lock", async () => {
    const s = await setup("date");
    await prisma.payment.delete({ where: { id: s.payment.id }, select: { id: true } });
    const eventSeriesId = "eventSeriesId" in s.owner ? s.owner.eventSeriesId : "";
    const result = await whileLocked(async (tx) => {
      await fenceOrganisation(tx, org.id);
      await tx.$queryRaw`SELECT "id" FROM "EventSeries" WHERE "id" = ${eventSeriesId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "EventInstance" WHERE "eventSeriesId" = ${eventSeriesId} ORDER BY "id" FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${s.order.id} FOR UPDATE`;
    }, s.remove, { beforeRelease: async (tx) => {
      await tx.payment.create({ data: {
        organisationId: org.id, orderId: s.order.id, amountMinor: BigInt(10000), currency: "GBP",
        provider: "OFFLINE", status: "PAID_OFFLINE", offlineMethod: "CASH", description: "Historical payment", paidAt: new Date(),
      }, select: { id: true } });
    } });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("earlier dates") });
    expect(await prisma.order.count({ where: { id: s.order.id, eventSeriesId } })).toBe(1);
  });

  it.each(["PENDING", "REQUESTED"] as const)("refuses a paid %s order even without a collected payment", async (status) => {
    const s = await setup("date");
    await prisma.payment.delete({ where: { id: s.payment.id }, select: { id: true } });
    await prisma.order.update({ where: { id: s.order.id }, data: { status, ...(status === "PENDING" ? { holdExpiresAt: new Date(Date.now() + 60_000), holdCapAt: new Date(Date.now() + 120_000) } : {}) }, select: { id: true } });
    expect(await s.remove()).toMatchObject({ ok: false });
  });
});
