import { randomUUID } from "node:crypto";
import { EventPermission, OrderStatus, PaymentRefundStatus, PaymentStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Refund lookups and refunds on ended orders (docs/PAYMENTS.md): a lookup
 * that fails in any way keeps the refund pending and its money committed, so
 * nobody can retry it into a second refund; money left on a cancelled order
 * is refunded by order, by owners and admins after a fresh sign-in.
 */

const session = vi.hoisted(() => ({ value: null as null | { user: { id: string; }; authenticatedAt?: number; } }));
vi.mock("@/lib/auth", () => ({ auth: async () => session.value }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));

import { prisma } from "@/lib/db";
import { refundEndedOrderAction } from "@/app/actions/payment-operations";
import { listRefundableOrders, PaymentOperationError, refundOrder, retryFailedRefund } from "@/lib/payments/operations";
import { newOrderReference } from "@/lib/payments/orders";
import { submitPendingRefund } from "@/lib/payments/refunds";
import { fake, paid, payOrder } from "./helpers/paidOrg";
import { buyOnline, email, onlineEvent, owner, setUpPaymentAudit, tearDownPaymentAudit } from "./helpers/paymentAudit";

beforeAll(() => setUpPaymentAudit("Final refunds"));
afterAll(() => tearDownPaymentAudit());

let buyers = 0;
async function paidOrder() {
  const { event, ticket } = await onlineEvent();
  buyers += 1;
  const order = await buyOnline({ eventSlug: event.slug }, ticket.id, `final-refund-${buyers}`);
  expect((await payOrder(order.id)).outcome).toBe("confirmed");
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
  return { event, order, payment };
}

describe.sequential("looking up a refund whose answer was lost", () => {
  it("keeps it pending when the lookup is refused (401), so it can't be retried into a second refund", async () => {
    const { order, payment } = await paidOrder();
    // The provider takes the refund, but its answer never arrives.
    fake.dropNext();
    await refundOrder({ orderId: order.id, organisationId: paid.organisationId, actorUserId: owner.id, amountMinor: BigInt(10000), reason: "Partial", cancelTickets: false });
    const refund = await prisma.paymentRefund.findFirstOrThrow({ where: { paymentId: payment.id } });
    expect(refund).toMatchObject({ status: PaymentRefundStatus.PENDING, externalRefundId: null });
    fake.refunds.push({ id: `rfnd_lost${buyers}`, paymentId: payment.externalPaymentId!, amount: 10000, reference: refund.id, status: "processed" });
    // The next pass looks it up first, and the keys are briefly wrong.
    const lease = () => prisma.paymentRefund.update({ where: { id: refund.id }, data: { submittedAt: new Date(Date.now() - 5 * 60_000) } });
    await lease();
    fake.failNextWith(401);
    expect(await submitPendingRefund(refund.id)).toBe("skipped");
    expect(await prisma.paymentRefund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: PaymentRefundStatus.PENDING });
    await expect(retryFailedRefund({ refundId: refund.id, organisationId: paid.organisationId, actorUserId: owner.id })).rejects.toThrow("Only a refund the provider refused can be retried.");
    // Its money stays committed: the rest of the payment is all that can go back.
    await expect(refundOrder({ orderId: order.id, organisationId: paid.organisationId, actorUserId: owner.id, amountMinor: payment.amountMinor, reason: "All", cancelTickets: false })).rejects.toBeInstanceOf(PaymentOperationError);
    // Keys fixed: the lookup finds the refund the provider took, and nothing is sent twice.
    await lease();
    expect(await submitPendingRefund(refund.id)).toBe("submitted");
    expect(await prisma.paymentRefund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: PaymentRefundStatus.SUCCEEDED, externalRefundId: `rfnd_lost${buyers}` });
    expect(fake.refunds.filter((item) => item.reference === refund.id)).toHaveLength(1);
  });

  it("still fails a refund the provider definitely refused to create", async () => {
    const { order, payment } = await paidOrder();
    fake.failNextWith(400);
    await refundOrder({ orderId: order.id, organisationId: paid.organisationId, actorUserId: owner.id, amountMinor: null, reason: "Refused", cancelTickets: false });
    expect(await prisma.paymentRefund.findFirstOrThrow({ where: { paymentId: payment.id } })).toMatchObject({ status: PaymentRefundStatus.FAILED });
  });
});

describe.sequential("refunding money left on a cancelled order", () => {
  it("lists it after a partial refund cancelled its tickets, and refunds the rest by order once", async () => {
    const { event, order, payment } = await paidOrder();
    await refundOrder({ orderId: order.id, organisationId: paid.organisationId, actorUserId: owner.id, amountMinor: BigInt(24950), reason: "Half, under the policy", cancelTickets: true });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: OrderStatus.CANCELLED });
    expect(await prisma.rSVP.count({ where: { orderId: order.id } })).toBe(0);
    expect((await listRefundableOrders({ eventId: event.id }, paid.organisationId)).map((row) => row.id)).toEqual([order.id]);

    const input = { organisationSlug: paid.orgSlug, eventId: event.id, orderId: order.id, amount: "", reason: "Goodwill: the rest" };
    const helper = await prisma.user.create({ data: { email: email(`ended-helper-${buyers}`), name: "Helper" } });
    await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: helper.id, permissions: [EventPermission.MANAGE_REGISTRATIONS] } });
    session.value = { user: { id: helper.id }, authenticatedAt: Date.now() };
    expect(await refundEndedOrderAction(input)).toMatchObject({ ok: false, error: expect.stringContaining("owners and admins") });
    session.value = { user: { id: owner.id }, authenticatedAt: Date.now() - 60 * 60_000 };
    expect(await refundEndedOrderAction(input)).toMatchObject({ ok: false, error: expect.stringContaining("sign in again") });
    vi.stubEnv("STAFF_MFA_REQUIRED", "true");
    session.value = { user: { id: owner.id }, authenticatedAt: Date.now() };
    expect(await refundEndedOrderAction(input)).toMatchObject({ ok: false });
    vi.stubEnv("STAFF_MFA_REQUIRED", "false");
    expect(await refundEndedOrderAction({ ...input, amount: "300" })).toMatchObject({ ok: false, error: expect.stringContaining("up to") });
    expect(await refundEndedOrderAction(input)).toEqual({ ok: true });

    const refunds = await prisma.paymentRefund.findMany({ where: { paymentId: payment.id }, orderBy: { createdAt: "asc" } });
    expect(refunds.map((refund) => [refund.amountMinor, refund.status])).toEqual([[BigInt(24950), PaymentRefundStatus.SUCCEEDED], [BigInt(24950), PaymentRefundStatus.SUCCEEDED]]);
    expect(await listRefundableOrders({ eventId: event.id }, paid.organisationId)).toEqual([]);
    expect(await refundEndedOrderAction(input)).toMatchObject({ ok: false });
    expect(await prisma.paymentRefund.count({ where: { paymentId: payment.id } })).toBe(2);
    session.value = null;
  });

  it("finds an older refundable order behind more than 200 fully refunded orders without RSVPs", async () => {
    const { event, order } = await paidOrder();
    await refundOrder({ orderId: order.id, organisationId: paid.organisationId, actorUserId: owner.id, amountMinor: BigInt(24950), reason: "Partial cancellation", cancelTickets: true });
    await prisma.order.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    const newer = Array.from({ length: 205 }, () => ({ orderId: randomUUID(), paymentId: randomUUID() }));
    await prisma.order.createMany({ data: newer.map(({ orderId }) => ({
      id: orderId, organisationId: paid.organisationId, eventId: event.id, reference: newOrderReference(), buyerEmail: email("exhausted"), buyerName: "Refunded buyer",
      status: OrderStatus.CANCELLED, currency: "INR", subtotalMinor: BigInt(10000), totalMinor: BigInt(10000),
    })) });
    await prisma.payment.createMany({ data: newer.map(({ orderId, paymentId }) => ({
      id: paymentId, orderId, organisationId: paid.organisationId, amountMinor: BigInt(10000), currency: "INR", provider: "OFFLINE", status: PaymentStatus.PAID_OFFLINE,
      offlineMethod: "CASH", description: "Returned cash", paidAt: new Date(),
    })) });
    await prisma.paymentRefund.createMany({ data: newer.map(({ paymentId }) => ({ paymentId, amountMinor: BigInt(10000), offline: true, status: PaymentRefundStatus.SUCCEEDED, settledAt: new Date() })) });
    expect(await prisma.rSVP.count({ where: { eventId: event.id } })).toBe(0);
    const rows = await listRefundableOrders({ eventId: event.id }, paid.organisationId);
    expect(rows.map((row) => row.id)).toEqual([order.id]);
    expect(await listRefundableOrders({ eventId: event.id }, randomUUID())).toEqual([]);
    session.value = { user: { id: owner.id }, authenticatedAt: Date.now() };
    expect(await refundEndedOrderAction({ organisationSlug: paid.orgSlug, eventId: event.id, orderId: rows[0].id, amount: "", reason: "Return the rest" })).toEqual({ ok: true });
    expect(await listRefundableOrders({ eventId: event.id }, paid.organisationId)).toEqual([]);
    session.value = null;
  });

  it("refunds confirmed orders only from the guest list", async () => {
    const { event, order } = await paidOrder();
    session.value = { user: { id: owner.id }, authenticatedAt: Date.now() };
    expect(await refundEndedOrderAction({ organisationSlug: paid.orgSlug, eventId: event.id, orderId: order.id, amount: "", reason: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("guest list") });
    expect(await listRefundableOrders({ eventId: event.id }, paid.organisationId)).toEqual([]);
    session.value = null;
  });
});
