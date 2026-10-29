import { randomUUID } from "node:crypto";
import type { AsyncLocalStorage } from "node:async_hooks";
import { EventStatus, OrderStatus, PaymentRefundStatus, PaymentStatus, RsvpStatus, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Deletion against payments (docs/PAYMENTS.md "Locks and races"): every
 * path that creates an order or payment takes the organisation fence first,
 * and organisation deletion takes the row FOR UPDATE and checks what is
 * still owed inside the same transaction, so whichever goes first, the other
 * sees it: no deadlock and no payment record lost. Event deletion re-checks
 * paid orders under the event lock. Membership changes serialise on the
 * organisation row.
 */

type Session = { user: { id: string; }; authenticatedAt: number; };
const ctx = vi.hoisted(() => ({ store: null as unknown as AsyncLocalStorage<Session> }));
vi.mock("@/lib/auth", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  ctx.store = new AsyncLocalStorage<Session>();
  return { auth: async () => ctx.store.getStore() ?? null };
});
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));

import { prisma } from "@/lib/db";
import { deleteOrganisation, removeMember, updateMemberRole } from "@/app/actions/membership";
import { deleteEvent } from "@/app/actions/event";
import { submitManualTicketOrderCore } from "@/lib/rsvpCore";
import { newOrderReference } from "@/lib/payments/orders";
import { setUpPaymentAudit, tearDownPaymentAudit } from "./helpers/paymentAudit";
import { backendPid, waitForLockWait } from "./helpers/lockWait";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const orgIds: string[] = [];
let counter = 0;
const mail = (name: string) => `${name}-${suffix}@example.test`;
const as = <T>(userId: string, run: () => Promise<T>) => ctx.store.run({ user: { id: userId }, authenticatedAt: Date.now() }, run);

beforeAll(() => setUpPaymentAudit("Final deletion"));
afterAll(async () => {
  await prisma.organisation.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `${suffix}@example.test` } } });
  await tearDownPaymentAudit();
});

/** An organisation of its own (these tests delete it), its owner, and an upcoming event selling a paid ticket. */
async function organisation() {
  counter += 1;
  const org = await prisma.organisation.create({ data: { name: `Deleting ${counter}`, slug: `deleting-${suffix}-${counter}` } });
  orgIds.push(org.id);
  const owner = await prisma.user.create({ data: { email: mail(`owner-${counter}`), name: "Owner", emailVerified: new Date(), memberships: { create: { organisationId: org.id, role: "OWNER" } } } });
  const start = new Date(Date.now() + 20 * 24 * 3_600_000);
  const event = await prisma.event.create({ data: {
    organisationId: org.id, title: `Paid night ${counter}`, slug: `paid-night-${suffix}-${counter}`, currency: "INR", status: EventStatus.PUBLISHED,
    startDateTime: start, endDateTime: new Date(start.getTime() + 3_600_000), timezone: "UTC", page: { create: { isPublished: true } },
  } });
  const ticket = await prisma.ticketType.create({ data: { eventId: event.id, name: "Entry", priceMinor: BigInt(50000) } });
  return { org, owner, event, ticket };
}

/** Run a transaction holding `lock` until the returned function releases it. */
async function holding(lock: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let locked!: (pid: number) => void;
  const isLocked = new Promise<number>((resolve) => { locked = resolve; });
  const holder = prisma.$transaction(async (tx) => { await lock(tx); locked(await backendPid(tx)); await released; }, { timeout: 20_000 });
  const pid = await isLocked;
  const unlock = async () => { release(); await holder; };
  return Object.assign(unlock, { wait: async (count = 1) => {
    try { await waitForLockWait(pid, count); } catch (error) { await unlock(); throw error; }
  } });
}

const lockEvent = (eventId: string) => (tx: Prisma.TransactionClient) => tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
const addPaidGuest = (setup: Awaited<ReturnType<typeof organisation>>, who: string) => submitManualTicketOrderCore(
  { eventId: setup.event.id, name: "Desk Guest", guestEmail: mail(who), ticketTypeId: setup.ticket.id, payment: "offline", method: "CASH", answers: {} },
  { organisationId: setup.org.id, actorUserId: setup.owner.id },
);

describe.sequential("deleting an organisation while a paid guest is added", () => {
  it("refuses the deletion when the payment got there first", async () => {
    const setup = await organisation();
    const release = await holding(lockEvent(setup.event.id));
    const adding = addPaidGuest(setup, "first-guest");
    void adding.catch(() => {});
    await release.wait();
    const deleting = as(setup.owner.id, () => deleteOrganisation({ organisationSlug: setup.org.slug }));
    void deleting.catch(() => {});
    await release.wait(2);
    await release();
    expect(await adding).toMatchObject({ ok: true });
    expect(await deleting).toMatchObject({ ok: false, error: expect.stringContaining("paid for upcoming events") });
    expect(await prisma.payment.findMany({ where: { organisationId: setup.org.id }, select: { status: true } })).toEqual([{ status: PaymentStatus.PAID_OFFLINE }]);
    expect(await prisma.auditEvent.count({ where: { action: "ORGANISATION_DELETED", targetId: setup.org.id } })).toBe(0);
  });

  it("turns the guest away when the deletion got there first", async () => {
    const setup = await organisation();
    const release = await holding(lockEvent(setup.event.id));
    // The deletion holds the organisation row and waits to remove the event.
    const deleting = as(setup.owner.id, () => deleteOrganisation({ organisationSlug: setup.org.slug }));
    void deleting.catch(() => {});
    await release.wait();
    const adding = addPaidGuest(setup, "second-guest");
    void adding.catch(() => {});
    await release.wait(2);
    await release();
    expect(await deleting).toEqual({ ok: true });
    expect(await adding).toMatchObject({ ok: false });
    expect(await prisma.organisation.count({ where: { id: setup.org.id } })).toBe(0);
    expect(await prisma.order.count({ where: { buyerEmail: mail("second-guest") } })).toBe(0);
  });
});

describe.sequential("deleting an event while a paid guest is added", () => {
  it("refuses the deletion when the payment got there first", async () => {
    const setup = await organisation();
    const release = await holding(lockEvent(setup.event.id));
    const adding = addPaidGuest(setup, "event-first");
    void adding.catch(() => {});
    await release.wait();
    const deleting = as(setup.owner.id, () => deleteEvent({ organisationSlug: setup.org.slug, eventId: setup.event.id }));
    void deleting.catch(() => {});
    await release.wait(2);
    await release();
    expect(await adding).toMatchObject({ ok: true });
    expect(await deleting).toMatchObject({ ok: false, error: expect.stringContaining("Cancel it instead") });
    expect(await prisma.rSVP.count({ where: { eventId: setup.event.id, status: RsvpStatus.CONFIRMED } })).toBe(1);
  });

  it("turns the guest away when the deletion got there first", async () => {
    const setup = await organisation();
    const release = await holding(lockEvent(setup.event.id));
    const deleting = as(setup.owner.id, () => deleteEvent({ organisationSlug: setup.org.slug, eventId: setup.event.id }));
    void deleting.catch(() => {});
    await release.wait();
    const adding = addPaidGuest(setup, "event-second");
    void adding.catch(() => {});
    await release.wait(2);
    await release();
    expect(await deleting).toEqual({ ok: true });
    expect(await adding).toMatchObject({ ok: false });
    expect(await prisma.order.count({ where: { organisationId: setup.org.id } })).toBe(0);
  });
});

describe.sequential("money still owed blocks deleting an organisation", () => {
  it("refuses while a cancelled event's refund is pending or failed, announcing nothing, then goes once it's paid back", async () => {
    const setup = await organisation();
    await prisma.event.update({ where: { id: setup.event.id }, data: { status: EventStatus.CANCELLED } });
    // A free upcoming event whose guest would be told it's off.
    const free = await prisma.event.create({ data: {
      organisationId: setup.org.id, title: "Free meetup", slug: `free-${suffix}-${counter}`, status: EventStatus.PUBLISHED,
      startDateTime: new Date(Date.now() + 10 * 24 * 3_600_000), endDateTime: new Date(Date.now() + 10 * 24 * 3_600_000 + 3_600_000), timezone: "UTC",
    } });
    await prisma.rSVP.create({ data: { eventId: free.id, guestEmail: mail("free-guest"), guestName: "Free Guest", attendeeKey: `guest:${mail("free-guest")}`, status: RsvpStatus.CONFIRMED } });
    const order = await prisma.order.create({ data: { organisationId: setup.org.id, eventId: setup.event.id, reference: newOrderReference(), buyerEmail: mail("buyer"), buyerName: "Buyer", status: OrderStatus.CANCELLED, currency: "INR", subtotalMinor: BigInt(50000), totalMinor: BigInt(50000) } });
    const payment = await prisma.payment.create({ data: { organisationId: setup.org.id, orderId: order.id, amountMinor: BigInt(50000), currency: "INR", provider: "RAZORPAY", status: PaymentStatus.PAID_ONLINE, externalPaymentId: `pay_del${suffix}`, description: "Paid night", paidAt: new Date() } });
    const refund = await prisma.paymentRefund.create({ data: { paymentId: payment.id, amountMinor: BigInt(50000), reason: "Event cancelled" } });
    const del = () => as(setup.owner.id, () => deleteOrganisation({ organisationSlug: setup.org.slug }));
    const told = () => prisma.outboxMessage.count({ where: { payload: { path: ["to"], equals: mail("free-guest") } } });

    expect(await del()).toMatchObject({ ok: false, error: expect.stringContaining("still on their way") });
    await prisma.paymentRefund.update({ where: { id: refund.id }, data: { status: PaymentRefundStatus.FAILED, settledAt: new Date() } });
    expect(await del()).toMatchObject({ ok: false, error: expect.stringContaining("failed and are still owed") });
    expect(await told()).toBe(0);
    expect(await prisma.auditEvent.count({ where: { action: "ORGANISATION_DELETED", targetId: setup.org.id } })).toBe(0);
    expect(await prisma.storageDeletion.count({ where: { organisationId: setup.org.id } })).toBe(0);

    await prisma.paymentRefund.create({ data: { paymentId: payment.id, amountMinor: BigInt(50000), reason: "Retry", retryOfRefundId: refund.id, status: PaymentRefundStatus.SUCCEEDED, settledAt: new Date() } });
    expect(await del()).toEqual({ ok: true });
    expect(await told()).toBe(1);
    expect(await prisma.organisation.count({ where: { id: setup.org.id } })).toBe(0);
  });
});

describe.sequential("membership changes", () => {
  it("never lets an admin remove someone the owner promoted meanwhile", async () => {
    const setup = await organisation();
    const admin = await prisma.user.create({ data: { email: mail("admin"), name: "Admin", memberships: { create: { organisationId: setup.org.id, role: "ADMIN" } } } });
    const member = await prisma.user.create({ data: { email: mail("member"), name: "Member", memberships: { create: { organisationId: setup.org.id, role: "MEMBER" } } } });
    const release = await holding((tx) => tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${setup.org.id} FOR UPDATE`);
    const promoting = as(setup.owner.id, () => updateMemberRole({ organisationSlug: setup.org.slug, targetUserId: member.id, role: "ADMIN" }));
    await release.wait();
    // The admin's check reads MEMBER before the promotion commits.
    const removing = as(admin.id, () => removeMember({ organisationSlug: setup.org.slug, targetUserId: member.id }));
    await release.wait(2);
    await release();
    expect(await promoting).toEqual({ ok: true });
    expect(await removing).toMatchObject({ ok: false, error: "Admins can only remove members." });
    expect(await prisma.membership.findUnique({ where: { userId_organisationId: { userId: member.id, organisationId: setup.org.id } } })).toMatchObject({ role: "ADMIN" });
    expect(await prisma.auditEvent.count({ where: { action: "MEMBER_REMOVED", organisationId: setup.org.id } })).toBe(0);
  });
});
