import { EventPermission, OrderStatus, PaymentRefundStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Refunds the provider refused or never finished (docs/PAYMENTS.md): a
 * failed refund is retried once by an owner or admin, even after its tickets
 * were cancelled, and maintenance asks the provider about accepted refunds
 * whose webhook never came, without ever failing one on a timeout.
 */

const session = vi.hoisted(() => ({ value: null as null | { user: { id: string; }; authenticatedAt?: number; } }));
vi.mock("@/lib/auth", () => ({ auth: async () => session.value }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));

import { prisma } from "@/lib/db";
import { retryFailedRefundAction } from "@/app/actions/payment-operations";
import { PaymentOperationError, refundOrder, retryFailedRefund } from "@/lib/payments/operations";
import { reconcileProviderRefunds } from "@/lib/payments/refundReconcile";
import { applyRefundNotification } from "@/lib/payments/refunds";
import { fake, paid, payOrder } from "./helpers/paidOrg";
import { buyOnline, email, onlineEvent, owner, setUpPaymentAudit, tearDownPaymentAudit, whileLocked } from "./helpers/paymentAudit";

beforeAll(() => setUpPaymentAudit("Audit refunds"));
afterAll(() => tearDownPaymentAudit());

let buyers = 0;

/** A paid order cancelled with a full refund that the provider refused. */
async function failedRefund() {
  const { event, ticket } = await onlineEvent();
  buyers += 1;
  const order = await buyOnline({ eventSlug: event.slug }, ticket.id, `refund-buyer-${buyers}`);
  expect((await payOrder(order.id)).outcome).toBe("confirmed");
  fake.failNextWith(400);
  await refundOrder({ orderId: order.id, organisationId: paid.organisationId, actorUserId: owner.id, amountMinor: null, reason: "Cancelled", cancelTickets: true });
  const refund = await prisma.paymentRefund.findFirstOrThrow({ where: { payment: { orderId: order.id } } });
  expect(refund.status).toBe(PaymentRefundStatus.FAILED);
  return { event, order, refund };
}

const failureNotices = () => prisma.outboxMessage.count({ where: { kind: "operator-notice", AND: [{ payload: { path: ["to"], equals: owner.email } }, { payload: { path: ["subject"], string_contains: "A refund failed" } }] } });

describe.sequential("retrying a failed refund", () => {
  it("creates exactly one replacement when two retries race, and never changes the failed row", async () => {
    const { order, refund } = await failedRefund();
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: OrderStatus.CANCELLED });
    const retry = () => retryFailedRefund({ refundId: refund.id, organisationId: paid.organisationId, actorUserId: owner.id });
    const results = await whileLocked((tx) => tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${refund.paymentId} FOR UPDATE`, () => Promise.allSettled([retry(), retry()]), { waiters: 2 });
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.any(PaymentOperationError) });
    const rows = await prisma.paymentRefund.findMany({ where: { paymentId: refund.paymentId }, orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: refund.id, status: PaymentRefundStatus.FAILED, updatedAt: refund.updatedAt });
    expect(rows[1]).toMatchObject({ retryOfRefundId: refund.id, amountMinor: refund.amountMinor, status: PaymentRefundStatus.SUCCEEDED });
    await expect(retry()).rejects.toThrow("This refund has already been retried.");
  });

  it("is for owners and admins with an authenticator check and a recent sign-in", async () => {
    const { event, refund } = await failedRefund();
    const input = { organisationSlug: paid.orgSlug, eventId: event.id, refundId: refund.id };
    const helper = await prisma.user.create({ data: { email: email("registrations-helper"), name: "Helper" } });
    await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: helper.id, permissions: [EventPermission.MANAGE_REGISTRATIONS] } });
    session.value = { user: { id: helper.id }, authenticatedAt: Date.now() };
    expect(await retryFailedRefundAction(input)).toMatchObject({ ok: false, error: expect.stringContaining("owners and admins") });
    session.value = { user: { id: owner.id }, authenticatedAt: Date.now() - 60 * 60_000 };
    expect(await retryFailedRefundAction(input)).toMatchObject({ ok: false, error: expect.stringContaining("sign in again") });
    vi.stubEnv("STAFF_MFA_REQUIRED", "true");
    session.value = { user: { id: owner.id }, authenticatedAt: Date.now() };
    expect(await retryFailedRefundAction(input)).toMatchObject({ ok: false });
    vi.stubEnv("STAFF_MFA_REQUIRED", "false");
    expect(await prisma.paymentRefund.count({ where: { retryOfRefundId: refund.id } })).toBe(0);
    expect(await retryFailedRefundAction(input)).toEqual({ ok: true });
    expect(await prisma.paymentRefund.count({ where: { retryOfRefundId: refund.id } })).toBe(1);
    session.value = null;
  });
});

describe.sequential("refunds the provider accepted but never finished", () => {
  /** A full refund the provider accepted and left pending, created over an hour ago. */
  async function providerPending() {
    const { event, ticket } = await onlineEvent();
    buyers += 1;
    const order = await buyOnline({ eventSlug: event.slug }, ticket.id, `pending-buyer-${buyers}`);
    expect((await payOrder(order.id)).outcome).toBe("confirmed");
    fake.refundsSettle("pending");
    await refundOrder({ orderId: order.id, organisationId: paid.organisationId, actorUserId: owner.id, amountMinor: null, reason: "Goodwill", cancelTickets: false });
    fake.refundsSettle("done");
    const refund = await prisma.paymentRefund.findFirstOrThrow({ where: { payment: { orderId: order.id } } });
    expect(refund).toMatchObject({ status: PaymentRefundStatus.PENDING, externalRefundId: expect.any(String) });
    await prisma.paymentRefund.update({ where: { id: refund.id }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60_000) } });
    return refund;
  }
  const providerSide = (externalRefundId: string | null) => fake.refunds.find((item) => item.id === externalRefundId)!;

  it("keeps a refund PENDING when the provider can't be reached, and moves it to the back", async () => {
    const refund = await providerPending();
    fake.dropNext();
    await reconcileProviderRefunds();
    expect(await prisma.paymentRefund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: PaymentRefundStatus.PENDING, lastCheckedAt: expect.any(Date) });
    providerSide(refund.externalRefundId).status = "processed";
    await reconcileProviderRefunds();
    expect(await prisma.paymentRefund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: PaymentRefundStatus.SUCCEEDED, settledAt: expect.any(Date) });
  });

  it("fails a refund the provider failed, telling the organisers once", async () => {
    const refund = await providerPending();
    providerSide(refund.externalRefundId).status = "failed";
    const before = await failureNotices();
    await reconcileProviderRefunds();
    expect(await prisma.paymentRefund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: PaymentRefundStatus.FAILED });
    expect(await failureNotices()).toBe(before + 1);
    // A late webhook, or another pass, says nothing more.
    await reconcileProviderRefunds();
    await prisma.$transaction((tx) => applyRefundNotification(tx, { organisationId: paid.organisationId, provider: "RAZORPAY" }, { refundId: refund.externalRefundId!, paymentId: null, reference: refund.id, state: "FAILED", amountMinor: null }));
    expect(await failureNotices()).toBe(before + 1);
    expect(await prisma.auditEvent.count({ where: { action: "PAYMENT_REFUND_FAILED", targetId: refund.id } })).toBe(1);
  });
});
