import { EventPrivacyType, OrderStatus, PaymentStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * docs/PAYMENTS.md and docs/FINANCE.md: test payments stay out of live money
 * totals; a paid solo place on an approval TEAM event is approved within the
 * units, never unpaid; and an invite-only ticket order is one place, for the
 * signed-in invitee, checked under the event lock.
 */

const session = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));

import { prisma } from "@/lib/db";
import { approveRsvp } from "@/app/actions/rsvp-lifecycle";
import { loadEventFinance } from "@/lib/finance";
import { loadRevenue } from "@/lib/payments/revenue";
import { newOrderReference, OrderError, reserveOrder } from "@/lib/payments/orders";
import { confirmRsvpWithinCapacity } from "@/lib/rsvpCapacity";
import { submitManualTicketOrderCore, submitRsvpCore } from "@/lib/rsvpCore";
import { createTeamEvent, paid, payOrder } from "./helpers/paidOrg";
import { buyOnline, email, onlineEvent, owner, setUpPaymentAudit, tearDownPaymentAudit, whileLocked } from "./helpers/paymentAudit";

beforeAll(() => setUpPaymentAudit("Final flows"));
afterAll(() => tearDownPaymentAudit());

describe.sequential("test payments in money totals", () => {
  it("keeps a test payment out of income, net and collected, and totals it apart", async () => {
    const { event, ticket } = await onlineEvent({ price: 100000 });
    const test = await buyOnline({ eventSlug: event.slug }, ticket.id, "test-money");
    expect((await payOrder(test.id)).outcome).toBe("confirmed");
    expect(await prisma.payment.findFirstOrThrow({ where: { orderId: test.id } })).toMatchObject({ testMode: true });
    expect(await submitManualTicketOrderCore({ eventId: event.id, name: "Desk Payer", guestEmail: email("real-money"), ticketTypeId: ticket.id, payment: "offline", method: "CASH", answers: {} }, { organisationId: paid.organisationId, actorUserId: owner.id })).toMatchObject({ ok: true });

    const finance = await loadEventFinance(event.id, paid.organisationId);
    expect(finance?.summary.tickets).toContain("1,000");
    expect(finance?.summary.netIncome).toContain("1,000");
    expect(finance?.summary.test).toMatchObject({ payments: 1, amount: expect.stringContaining("1,000") });
    const revenue = await loadRevenue({ eventId: event.id }, "UTC");
    expect(revenue).toMatchObject({ collectedMinor: 100000, netMinor: 100000, orders: { paid: 1 }, test: { payments: 1, collectedMinor: 100000 } });
    expect(revenue?.byMethod).toEqual([{ label: "Cash", payments: 1, amountMinor: 100000 }]);
  });
});

describe.sequential("approving a paid solo place on an approval TEAM event", () => {
  async function paidSolo(capacity: number) {
    const { event, ticket } = await createTeamEvent({ capacity, privacyType: EventPrivacyType.APPROVAL_REQUIRED });
    const result = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: email(`solo-${event.id}`), name: "Solo Payer", answers: {}, items: [{ ticketTypeId: ticket.id, quantity: 1 }] }, { userId: null, team: { mode: "solo" } });
    expect(result).toMatchObject({ ok: true, data: { status: RsvpStatus.PENDING_PAYMENT } });
    const order = await prisma.order.findFirstOrThrow({ where: { eventId: event.id }, include: { rsvps: true } });
    expect((await payOrder(order.id)).outcome).toBe("confirmed");
    const rsvp = await prisma.rSVP.findUniqueOrThrow({ where: { id: order.rsvps[0]!.id } });
    expect(rsvp.status).toBe(RsvpStatus.PENDING_APPROVAL);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: OrderStatus.CONFIRMED });
    return { event, ticket, rsvp };
  }
  const approve = (eventId: string, rsvpId: string) => approveRsvp({ organisationSlug: paid.orgSlug, eventId, rsvpId });

  it("confirms it once paid, within the event's units", async () => {
    const { event, rsvp } = await paidSolo(1);
    session.userId = owner.id;
    const taken = await prisma.rSVP.create({ data: { eventId: event.id, guestEmail: email("unit-taker"), guestName: "Unit", attendeeKey: `guest:${email("unit-taker")}`, status: RsvpStatus.CONFIRMED } });
    expect(await approve(event.id, rsvp.id)).toMatchObject({ ok: false, code: "CAPACITY_FULL" });
    await prisma.rSVP.delete({ where: { id: taken.id } });
    expect(await approve(event.id, rsvp.id)).toEqual({ ok: true });
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: rsvp.id } })).toMatchObject({ status: RsvpStatus.CONFIRMED });
    session.userId = "";
  });

  it("never confirms one whose order isn't paid", async () => {
    const { event, ticket } = await createTeamEvent({ capacity: 5, privacyType: EventPrivacyType.APPROVAL_REQUIRED });
    const order = await prisma.order.create({ data: { organisationId: paid.organisationId, eventId: event.id, reference: newOrderReference(), buyerEmail: email("unpaid-solo"), buyerName: "Unpaid", status: OrderStatus.CONFIRMED, currency: "INR", subtotalMinor: BigInt(49900), totalMinor: BigInt(49900) } });
    await prisma.payment.create({ data: { organisationId: paid.organisationId, orderId: order.id, amountMinor: BigInt(49900), currency: "INR", provider: "OFFLINE", status: PaymentStatus.PENDING, description: "Desk" } });
    const rsvp = await prisma.rSVP.create({ data: { eventId: event.id, guestEmail: email("unpaid-solo"), guestName: "Unpaid", attendeeKey: `guest:${email("unpaid-solo")}`, status: RsvpStatus.PENDING_APPROVAL, orderId: order.id, ticketTypeId: ticket.id } });
    expect(await confirmRsvpWithinCapacity({ rsvpId: rsvp.id, eventId: event.id, expectedStatuses: [RsvpStatus.PENDING_APPROVAL], requireOpen: true })).toBe("changed");
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: rsvp.id } })).toMatchObject({ status: RsvpStatus.PENDING_APPROVAL });
  });
});

describe.sequential("invite-only ticket orders", () => {
  async function inviteOnly(seatsPerTicket = 1) {
    const { event, ticket } = await onlineEvent({ price: 0, privacyType: EventPrivacyType.INVITE_ONLY });
    await prisma.ticketType.update({ where: { id: ticket.id }, data: { maxPerOrder: 4, seatsPerTicket } });
    const invitee = await prisma.user.create({ data: { email: email(`invitee-${event.id}`), name: "Invited Alice", emailVerified: new Date() } });
    await prisma.eventInvite.create({ data: { eventId: event.id, email: invitee.email! } });
    return { event, ticket, invitee };
  }
  const order = (event: { slug: string; }, ticketTypeId: string, userId: string, extra: { quantity?: number; attendees?: Array<{ name?: string; email?: string; }>; } = {}) => submitRsvpCore(
    { orgSlug: paid.orgSlug, eventSlug: event.slug, name: "Alice", answers: {}, items: [{ ticketTypeId, quantity: extra.quantity ?? 1 }], attendees: extra.attendees ?? [] },
    { userId },
  );

  it("gives the invitee one place, and refuses an uninvited extra attendee or a second ticket", async () => {
    const { event, ticket, invitee } = await inviteOnly();
    const bob = { name: "Bob", email: email("uninvited-bob") };
    expect(await order(event, ticket.id, invitee.id, { quantity: 2, attendees: [bob] })).toMatchObject({ ok: false, error: expect.stringContaining("one person") });
    expect(await order(event, ticket.id, invitee.id, { quantity: 1, attendees: [bob] })).toMatchObject({ ok: false, error: expect.stringContaining("one person") });
    expect(await prisma.rSVP.count({ where: { eventId: event.id } })).toBe(0);
    expect(await order(event, ticket.id, invitee.id)).toMatchObject({ ok: true });
    expect(await prisma.rSVP.findMany({ where: { eventId: event.id }, select: { userId: true, status: true } })).toEqual([{ userId: invitee.id, status: RsvpStatus.CONFIRMED }]);
  });

  it("refuses a group ticket that seats more than one", async () => {
    const { event, ticket, invitee } = await inviteOnly(2);
    expect(await order(event, ticket.id, invitee.id)).toMatchObject({ ok: false, error: expect.stringContaining("one person") });
    expect(await prisma.rSVP.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("refuses an anonymous order inside the reservation", async () => {
    const { event, ticket } = await inviteOnly();
    await expect(prisma.$transaction((tx) => reserveOrder(tx, {
      target: { eventId: event.id }, items: [{ ticketTypeId: ticket.id, quantity: 1 }], attendees: [], enforceOpen: true,
      buyer: { userId: null, email: email("anonymous"), name: "Anon", attendeeKey: `guest:${email("anonymous")}` },
    }))).rejects.toThrow(OrderError);
  });

  it("refuses an uninvited buyer whose event turned invite-only while they waited for the lock", async () => {
    const { event, ticket } = await onlineEvent({ price: 0 });
    const carol = await prisma.user.create({ data: { email: email("carol"), name: "Carol", emailVerified: new Date() } });
    const result = await whileLocked(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`;
      await tx.event.update({ where: { id: event.id }, data: { privacyType: EventPrivacyType.INVITE_ONLY } });
    }, () => order(event, ticket.id, carol.id));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("invite-only") });
    expect(await prisma.rSVP.count({ where: { eventId: event.id } })).toBe(0);
  });
});
