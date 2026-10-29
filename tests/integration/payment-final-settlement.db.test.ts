import { EventPrivacyType, OrderStatus, PaymentRefundStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Late and delayed settlement (docs/PAYMENTS.md "Locks and races"): whether
 * a hold is still live is read under the locks, so a payment whose provider
 * call outlived its hold never takes a place resold meanwhile; an ended
 * hold gets back its ticket type's place and its promo code's use only if
 * they are still there, checked before a team place changes; reopening or
 * re-accepting an order re-checks its promo code.
 */

vi.mock("@/lib/auth", () => ({ auth: async () => null }));

import { prisma } from "@/lib/db";
import { closeOpenAttempts } from "@/lib/payments/checkout";
import { seatTakingWhere } from "@/lib/payments/holds";
import { declineRequestedOrder, PaymentOperationError, reacceptDeclinedOrder, sendPaymentLink, settleOrderByHand } from "@/lib/payments/operations";
import { promoCodeDigest, promoCodeHint } from "@/lib/payments/promo";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { createTeamEvent, fake, paid, payOrder } from "./helpers/paidOrg";
import { buyOnline, email, onlineEvent, owner, setUpPaymentAudit, tearDownPaymentAudit } from "./helpers/paymentAudit";

beforeAll(() => setUpPaymentAudit("Final settlement"));
afterAll(() => tearDownPaymentAudit());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The order's hold (and its places') ends `inMs` from now. */
async function holdEndsIn(orderId: string, inMs: number) {
  const ends = new Date(Date.now() + inMs);
  await prisma.order.update({ where: { id: orderId }, data: { holdExpiresAt: ends } });
  await prisma.rSVP.updateMany({ where: { orderId }, data: { holdExpiresAt: ends } });
  return ends;
}

/**
 * Hold the next request that closes a provider page until `release` is
 * called: the settlement waits there with the time it read before the call.
 */
function gatePageClose() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => { reached = resolve; });
  let gated = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!gated && String(input).includes("/cancel")) {
      gated = true;
      reached();
      await opened;
    }
    return fake.fetch(input, init);
  });
  return { waiting, release: () => { release(); vi.stubGlobal("fetch", fake.fetch); } };
}

const seatsTaken = (eventId: string) => prisma.rSVP.count({ where: { eventId, ...seatTakingWhere(new Date()) } });
const confirmed = (eventId: string) => prisma.rSVP.count({ where: { eventId, status: RsvpStatus.CONFIRMED } });
const pageOf = async (orderId: string) => (await prisma.paymentCheckoutAttempt.findFirstOrThrow({ where: { payment: { orderId } }, orderBy: { createdAt: "desc" } })).externalId!;

describe.sequential("settling after the hold ended while the provider was asked", () => {
  it("refunds a captured payment whose hold ended before its settlement got the locks", async () => {
    const { event, ticket } = await onlineEvent({ capacity: 1 });
    const a = await buyOnline({ eventSlug: event.slug }, ticket.id, "late-webhook-a");
    fake.pay(await pageOf(a.id));
    const ends = await holdEndsIn(a.id, 1200);
    const gate = gatePageClose();
    // A's settlement reads the time now (hold live), then waits on the provider.
    const settling = closeOpenAttempts(a.id);
    await gate.waiting;
    await sleep(Math.max(0, ends.getTime() - Date.now()) + 100);
    // B reserves after A's hold ended, before A's settlement takes the event lock.
    const b = await buyOnline({ eventSlug: event.slug }, ticket.id, "late-webhook-b");
    expect(b.status).toBe(OrderStatus.PENDING);
    gate.release();
    expect(await settling).toBe("settled");
    expect(await prisma.order.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: OrderStatus.EXPIRED });
    expect(await prisma.paymentRefund.findFirst({ where: { payment: { orderId: a.id } } })).toMatchObject({ automatic: true, status: PaymentRefundStatus.SUCCEEDED });
    expect(await confirmed(event.id)).toBe(0);
    expect(await seatsTaken(event.id)).toBe(1);
  });

  it("refuses to settle by hand a hold that ended while its page was being closed", async () => {
    const { event, ticket } = await onlineEvent({ capacity: 1 });
    const a = await buyOnline({ eventSlug: event.slug }, ticket.id, "late-desk-a");
    const ends = await holdEndsIn(a.id, 1200);
    const gate = gatePageClose();
    const settling = settleOrderByHand({ orderId: a.id, organisationId: paid.organisationId, actorUserId: owner.id, mode: "offline", method: "CASH" });
    const outcome = settling.then(() => "confirmed", (error: unknown) => error);
    await gate.waiting;
    await sleep(Math.max(0, ends.getTime() - Date.now()) + 100);
    const b = await buyOnline({ eventSlug: event.slug }, ticket.id, "late-desk-b");
    expect(b.status).toBe(OrderStatus.PENDING);
    gate.release();
    const result = await outcome;
    expect(result).toBeInstanceOf(PaymentOperationError);
    expect((result as Error).message).toBe("The hold ended and the places have gone.");
    expect(await prisma.order.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: OrderStatus.PENDING });
    expect(await confirmed(event.id)).toBe(0);
    expect(await seatsTaken(event.id)).toBe(1);
  });
});

describe.sequential("a late payment on a TEAM event", () => {
  const register = (eventSlug: string, who: string, ticketTypeId: string, team: { mode: "solo"; } | { mode: "create"; name: string; }) => submitRsvpCore(
    { orgSlug: paid.orgSlug, eventSlug, guestEmail: email(who), name: "Team Person", answers: {}, items: [{ ticketTypeId, quantity: 1 }] },
    { userId: null, team },
  );
  const orderOf = (who: string) => prisma.order.findFirstOrThrow({ where: { buyerEmail: email(who) }, orderBy: { createdAt: "desc" } });

  it("is refunded when its ticket type sold out meanwhile, though event units are free, and no team is confirmed", async () => {
    const { event, ticket } = await createTeamEvent({ capacity: 10 });
    await prisma.ticketType.update({ where: { id: ticket.id }, data: { capacity: 1 } });
    expect(await register(event.slug, "team-late-a", ticket.id, { mode: "create", name: "Late Larks" })).toMatchObject({ ok: true });
    const a = await orderOf("team-late-a");
    await holdEndsIn(a.id, -1000);
    expect(await register(event.slug, "team-late-b", ticket.id, { mode: "solo" })).toMatchObject({ ok: true });
    expect((await payOrder((await orderOf("team-late-b")).id)).outcome).toBe("confirmed");
    expect(await payOrder(a.id)).toMatchObject({ outcome: "refunding" });
    expect(await prisma.rSVP.count({ where: { ticketTypeId: ticket.id, status: RsvpStatus.CONFIRMED } })).toBe(1);
    expect(await prisma.team.count({ where: { eventId: event.id, status: RsvpStatus.CONFIRMED } })).toBe(0);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: OrderStatus.EXPIRED });
  });
});

describe.sequential("a promo code's use after it was released", () => {
  let codes = 0;
  async function limitedCode(eventId: string) {
    codes += 1;
    const code = `ONCE${codes}${paid.suffix.slice(0, 6)}`.toUpperCase();
    await prisma.promoCode.create({ data: { eventId, codeDigest: promoCodeDigest(code), hint: promoCodeHint(code), kind: "PERCENT", percentOff: 50, maxRedemptions: 1 } });
    return code;
  }
  async function buyWithCode(eventSlug: string, ticketTypeId: string, who: string, promoCode: string) {
    const result = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug, guestEmail: email(who), name: "Promo Buyer", answers: {}, items: [{ ticketTypeId, quantity: 1 }], promoCode }, { userId: null });
    expect(result).toMatchObject({ ok: true });
    return prisma.order.findFirstOrThrow({ where: { buyerEmail: email(who) }, orderBy: { createdAt: "desc" } });
  }
  const redeemed = (promoCodeId: string) => prisma.order.count({ where: { promoCodeId, status: OrderStatus.CONFIRMED } });

  it("refunds a late payment whose code was used up meanwhile", async () => {
    const { event, ticket } = await onlineEvent();
    const code = await limitedCode(event.id);
    const a = await buyWithCode(event.slug, ticket.id, "promo-late-a", code);
    await holdEndsIn(a.id, -1000);
    const b = await buyWithCode(event.slug, ticket.id, "promo-late-b", code);
    expect((await payOrder(b.id)).outcome).toBe("confirmed");
    expect(await payOrder(a.id)).toMatchObject({ outcome: "refunding" });
    expect(await redeemed(a.promoCodeId!)).toBe(1);
  });

  it("refuses to reopen an expired order whose code was used up meanwhile", async () => {
    const { event, ticket } = await onlineEvent();
    const code = await limitedCode(event.id);
    const a = await buyWithCode(event.slug, ticket.id, "promo-reopen-a", code);
    await holdEndsIn(a.id, -1000);
    await prisma.order.update({ where: { id: a.id }, data: { status: OrderStatus.EXPIRED } });
    await prisma.payment.updateMany({ where: { orderId: a.id }, data: { status: "EXPIRED" } });
    await prisma.paymentCheckoutAttempt.updateMany({ where: { payment: { orderId: a.id } }, data: { status: "EXPIRED" } });
    await buyWithCode(event.slug, ticket.id, "promo-reopen-b", code);
    await expect(sendPaymentLink({ orderId: a.id, organisationId: paid.organisationId, actorUserId: owner.id })).rejects.toThrow("used up since the hold ended");
    expect(await prisma.order.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: OrderStatus.EXPIRED });
  });

  it("refuses to re-accept a declined request whose code was used up meanwhile, changing nothing", async () => {
    const { event, ticket } = await onlineEvent({ privacyType: EventPrivacyType.APPROVAL_REQUIRED });
    const code = await limitedCode(event.id);
    const a = await buyWithCode(event.slug, ticket.id, "promo-reaccept-a", code);
    expect(a.status).toBe(OrderStatus.REQUESTED);
    await declineRequestedOrder({ orderId: a.id, organisationId: paid.organisationId, actorUserId: owner.id });
    const b = await buyWithCode(event.slug, ticket.id, "promo-reaccept-b", code);
    expect(b.status).toBe(OrderStatus.REQUESTED);
    await expect(reacceptDeclinedOrder({ orderId: a.id, organisationId: paid.organisationId, actorUserId: owner.id })).rejects.toThrow("used up since it was declined");
    expect(await prisma.order.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: OrderStatus.CANCELLED });
    expect(await prisma.rSVP.findMany({ where: { orderId: a.id }, select: { status: true } })).toEqual([{ status: RsvpStatus.REJECTED }]);
    // Once B's request goes, A can come back.
    await declineRequestedOrder({ orderId: b.id, organisationId: paid.organisationId, actorUserId: owner.id });
    expect(await reacceptDeclinedOrder({ orderId: a.id, organisationId: paid.organisationId, actorUserId: owner.id })).toBe("offered");
  });
});
