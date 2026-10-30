import { randomUUID } from "node:crypto";
import { EventStatus, OrderStatus, PaymentStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined, updateTag: () => undefined }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));

import { cancelEvent, deleteEvent } from "@/app/actions/event";
import { prisma } from "@/lib/db";
import { INSTANCE_SETTINGS_ID } from "@/lib/instanceSettings";
import { runPaymentMaintenance } from "@/lib/payments/maintenance";
import { cancelOrderAsBuyer, PaymentOperationError, refundOrder, settleOrderByHand } from "@/lib/payments/operations";
import { encryptPaymentSecret } from "@/lib/payments/secrets";
import { newWebhookPathId } from "@/lib/payments/settings";
import { transferTicket } from "@/lib/payments/transfers";
import { handleProviderWebhook, settleWebhookEvent } from "@/lib/payments/webhooks";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { createFakeProvider, FAKE_PROVIDER_ORIGIN, signedPaidWebhook, signedWebhook } from "../helpers/fakeProviderFetch";

const suffix = randomUUID().replace(/-/g, "").slice(0, 16);
const SECRETS = { RAZORPAY: `rzp-webhook-${suffix}`, STRIPE: `whsec_${suffix}` } as const;
const pathId = newWebhookPathId();
const fake = createFakeProvider();
let organisationId = "";
let orgSlug = "";
let owner = "";
let previousPaidEvents: boolean | null = null;
let counter = 0;
const email = (name: string) => `${name}-${suffix}@example.test`;

async function createEvent(options: { allowTransfers?: boolean; start?: Date; payAtDesk?: boolean; } = {}) {
  counter += 1;
  const start = options.start ?? new Date("2035-01-01T10:00:00.000Z");
  const event = await prisma.event.create({
    data: {
      organisationId, title: `After ${counter}`, slug: `after-${suffix}-${counter}`, currency: "INR", capacity: 50,
      startDateTime: start, endDateTime: new Date(start.getTime() + 2 * 3_600_000), timezone: "UTC",
      status: EventStatus.PUBLISHED, page: { create: { isPublished: true } }, allowTransfers: options.allowTransfers ?? false, transferCutoffHours: 24,
    },
  });
  const ticket = await prisma.ticketType.create({ data: { eventId: event.id, name: "General", priceMinor: BigInt(49900), payAtDesk: options.payAtDesk ?? false } });
  return { event, ticket };
}

function buy(eventSlug: string, who: string, ticketTypeId: string, extra: Record<string, unknown> = {}) {
  return submitRsvpCore({ orgSlug, eventSlug, guestEmail: email(who), name: "After Buyer", answers: {}, items: [{ ticketTypeId, quantity: 1 }], attendees: [], ...extra }, { userId: null });
}

async function orderOf(who: string) {
  return prisma.order.findFirstOrThrow({ where: { buyerEmail: email(who) }, include: { payments: { include: { attempts: true, disputes: true } }, rsvps: true }, orderBy: { createdAt: "desc" } });
}

async function pay(who: string, provider: "RAZORPAY" | "STRIPE" = "RAZORPAY") {
  const order = await orderOf(who);
  const page = [...fake.pages.values()].find((candidate) => candidate.id === order.payments[0]!.attempts[0]!.externalId)!;
  fake.pay(page.id);
  expect((await handleProviderWebhook(signedPaidWebhook(fake.pages.get(page.id)!, SECRETS[provider], `/api/webhooks/${provider.toLowerCase()}/${pathId}`), provider, pathId, settleWebhookEvent)).status).toBe(200);
  return orderOf(who);
}

const outbox = (kind: string, path: string[], value: string) => prisma.outboxMessage.count({ where: { kind, payload: { path, equals: value } } });

beforeAll(async () => {
  vi.stubEnv("MFA_ENCRYPTION_KEY", process.env.MFA_ENCRYPTION_KEY || Buffer.alloc(32, 9).toString("base64"));
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "http://127.0.0.1:3999");
  vi.stubEnv("PAYMENTS_FAKE_PROVIDER_URL", FAKE_PROVIDER_ORIGIN);
  vi.stubGlobal("fetch", fake.fetch);
  const organisation = await prisma.organisation.create({ data: { name: "After org", slug: `after-org-${suffix}` } });
  organisationId = organisation.id;
  orgSlug = organisation.slug;
  owner = (await prisma.user.create({ data: { name: "Owner", email: email("owner"), emailVerified: new Date(), memberships: { create: { organisationId, role: "OWNER" } } } })).id;
  await prisma.organisationPaymentSettings.create({ data: {
    organisationId, provider: "RAZORPAY", webhookPathId: pathId, razorpayKeyId: "rzp_test_abcdef",
    razorpayKeySecretEncrypted: encryptPaymentSecret(organisationId, "razorpayKeySecretEncrypted", "secretvalue"),
    razorpayWebhookSecretEncrypted: encryptPaymentSecret(organisationId, "razorpayWebhookSecretEncrypted", SECRETS.RAZORPAY),
    stripeSecretKeyEncrypted: encryptPaymentSecret(organisationId, "stripeSecretKeyEncrypted", "sk_test_abcdefghijkl"),
    stripeWebhookSecretEncrypted: encryptPaymentSecret(organisationId, "stripeWebhookSecretEncrypted", SECRETS.STRIPE),
    stripeTestMode: true,
  } });
  previousPaidEvents = (await prisma.instanceSetting.findUnique({ where: { id: INSTANCE_SETTINGS_ID } }))?.paidEventsEnabled ?? null;
  await prisma.instanceSetting.upsert({ where: { id: INSTANCE_SETTINGS_ID }, create: { id: INSTANCE_SETTINGS_ID, paidEventsEnabled: true }, update: { paidEventsEnabled: true } });
});

afterAll(async () => {
  await prisma.organisation.deleteMany({ where: { id: organisationId } });
  await prisma.user.deleteMany({ where: { id: owner } });
  if (previousPaidEvents === null) await prisma.instanceSetting.updateMany({ where: { id: INSTANCE_SETTINGS_ID }, data: { paidEventsEnabled: false } });
  else await prisma.instanceSetting.update({ where: { id: INSTANCE_SETTINGS_ID }, data: { paidEventsEnabled: previousPaidEvents } });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await prisma.$disconnect();
});

describe.sequential("after purchase", { timeout: 30_000 }, () => {
  it("emails the buyer when a complimentary order is cancelled", async () => {
    const { event, ticket } = await createEvent();
    await buy(event.slug, "comp", ticket.id);
    const order = await orderOf("comp");
    await settleOrderByHand({ orderId: order.id, organisationId, actorUserId: owner, mode: "waive" });
    await refundOrder({ orderId: order.id, organisationId, actorUserId: owner, amountMinor: null, reason: "Plans changed", cancelTickets: true });
    expect((await orderOf("comp")).status).toBe(OrderStatus.CANCELLED);
    expect(await outbox("payment-notice", ["notice"], "cancelled")).toBeGreaterThanOrEqual(1);
  });

  it("reminds a buyer once, a few hours before a day-long payment link runs out", async () => {
    const { event, ticket } = await createEvent();
    await buy(event.slug, "remind", ticket.id);
    const order = await orderOf("remind");
    const ends = new Date(Date.now() + 2 * 3_600_000);
    await prisma.order.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 22 * 3_600_000), holdExpiresAt: ends, holdCapAt: new Date(ends.getTime() + 1_800_000) } });
    await prisma.rSVP.updateMany({ where: { orderId: order.id }, data: { holdExpiresAt: ends } });
    expect((await runPaymentMaintenance()).reminded).toBeGreaterThanOrEqual(1);
    expect((await runPaymentMaintenance()).reminded).toBe(0);
    expect(await prisma.outboxMessage.count({ where: { kind: "payment-notice", payload: { path: ["paymentId"], equals: order.payments[0]!.id } } })).toBeGreaterThanOrEqual(2);
    expect((await orderOf("remind")).paymentReminderSentAt).not.toBeNull();
  });

  it.each(["RAZORPAY", "STRIPE"] as const)("records %s disputes from webhooks and tells the owner, cancelling nothing", async (provider) => {
    await prisma.organisationPaymentSettings.update({ where: { organisationId }, data: { provider } });
    const { event, ticket } = await createEvent();
    const who = `dispute-${provider.toLowerCase()}`;
    await buy(event.slug, who, ticket.id);
    const paid = await pay(who, provider);
    const paymentId = paid.payments[0]!.externalPaymentId!;
    const disputeId = provider === "RAZORPAY" ? `disp_${suffix.slice(0, 10)}` : `dp_${suffix.slice(0, 10)}`;
    const path = `/api/webhooks/${provider.toLowerCase()}/${pathId}`;
    const opened = provider === "RAZORPAY"
      ? { event: "payment.dispute.created", payload: { dispute: { entity: { id: disputeId, payment_id: paymentId, amount: 49900, currency: "INR", reason_code: "fraudulent", status: "open", respond_by: 2_000_000_000 } } } }
      : { type: "charge.dispute.created", data: { object: { id: disputeId, payment_intent: paymentId, amount: 49900, currency: "inr", reason: "fraudulent", status: "needs_response", evidence_details: { due_by: 2_000_000_000 } } } };
    expect((await handleProviderWebhook(signedWebhook(provider === "RAZORPAY" ? "razorpay" : "stripe", opened, SECRETS[provider], path, `evt_open_${disputeId}`), provider, pathId, settleWebhookEvent)).status).toBe(200);
    let order = await orderOf(who);
    expect(order.payments[0]!.disputes).toEqual([expect.objectContaining({ status: "OPEN", amountMinor: BigInt(49900), reason: "fraudulent", respondBy: new Date(2_000_000_000_000) })]);
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    expect(await prisma.outboxMessage.count({ where: { kind: "operator-notice", payload: { path: ["subject"], string_contains: "Payment dispute opened" } } })).toBeGreaterThanOrEqual(1);

    const won = provider === "RAZORPAY"
      ? { event: "payment.dispute.won", payload: { dispute: { entity: { id: disputeId, payment_id: paymentId, amount: 49900, currency: "INR", status: "won" } } } }
      : { type: "charge.dispute.closed", data: { object: { id: disputeId, payment_intent: paymentId, amount: 49900, currency: "inr", status: "won" } } };
    await handleProviderWebhook(signedWebhook(provider === "RAZORPAY" ? "razorpay" : "stripe", won, SECRETS[provider], path, `evt_won_${disputeId}`), provider, pathId, settleWebhookEvent);
    order = await orderOf(who);
    expect(order.payments[0]!.disputes).toEqual([expect.objectContaining({ status: "WON" })]);
  });

  it("reserves to pay at the desk, records the money when collected, and releases it if cancelled", async () => {
    const { event, ticket } = await createEvent({ payAtDesk: true });
    expect(await buy(event.slug, "desk", ticket.id, { payAtDesk: true })).toMatchObject({ ok: true, data: { status: RsvpStatus.CONFIRMED, checkoutUrl: null } });
    let order = await orderOf("desk");
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    expect(order.payments).toEqual([expect.objectContaining({ status: PaymentStatus.PENDING, provider: "OFFLINE", amountMinor: BigInt(49900) })]);
    expect(await outbox("payment-notice", ["notice"], "desk")).toBeGreaterThanOrEqual(1);
    await settleOrderByHand({ orderId: order.id, organisationId, actorUserId: owner, mode: "offline", method: "CASH" });
    order = await orderOf("desk");
    expect(order.payments[0]).toMatchObject({ status: PaymentStatus.PAID_OFFLINE, offlineMethod: "CASH" });

    await buy(event.slug, "desk-cancel", ticket.id, { payAtDesk: true });
    await cancelOrderAsBuyer({ orderId: (await orderOf("desk-cancel")).id });
    const cancelled = await orderOf("desk-cancel");
    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
    expect(cancelled.payments[0]!.status).toBe(PaymentStatus.CANCELED);

    // A ticket that must be paid online can't be reserved at the desk.
    const online = await createEvent();
    expect(await buy(online.event.slug, "desk-refused", online.ticket.id, { payAtDesk: true })).toEqual({ ok: false, error: "Some of these tickets must be paid online." });
  });

  it("transfers a ticket where allowed: new holder, new link, old link gone", async () => {
    await prisma.organisationPaymentSettings.update({ where: { organisationId }, data: { provider: "RAZORPAY" } });
    const closed = await createEvent();
    await buy(closed.event.slug, "no-transfer", closed.ticket.id);
    const blocked = await pay("no-transfer");
    await expect(transferTicket({ orderToken: blocked.accessToken, rsvpId: blocked.rsvps[0]!.id, name: "Friend", email: email("friend-0") })).rejects.toThrow(/doesn't allow/);

    const open = await createEvent({ allowTransfers: true });
    await buy(open.event.slug, "giver", open.ticket.id);
    const order = await pay("giver");
    const before = order.rsvps[0]!;
    await transferTicket({ orderToken: order.accessToken, rsvpId: before.id, name: "New Holder", email: email("receiver") });
    const after = await prisma.rSVP.findUniqueOrThrow({ where: { id: before.id } });
    expect(after).toMatchObject({ guestEmail: email("receiver"), guestName: "New Holder", attendeeKey: `guest:${email("receiver")}`, userId: null, status: RsvpStatus.CONFIRMED });
    expect(after.checkInToken).not.toBe(before.checkInToken);
    expect(await prisma.rSVP.findUnique({ where: { checkInToken: before.checkInToken } })).toBeNull();
    expect(await outbox("rsvp-confirmation", ["to"], email("receiver"))).toBe(1);

    // Too close to the start: no more transfers.
    const soon = await createEvent({ allowTransfers: true, start: new Date(Date.now() + 3 * 3_600_000) });
    await buy(soon.event.slug, "late-giver", soon.ticket.id);
    const late = await pay("late-giver");
    await expect(transferTicket({ orderToken: late.accessToken, rsvpId: late.rsvps[0]!.id, name: "Friend", email: email("friend-1") })).rejects.toThrow(PaymentOperationError);
  });

  it("cancels an event: paid orders refunded in full, free guests emailed, holds released, delete refused", async () => {
    await prisma.organisationPaymentSettings.update({ where: { organisationId }, data: { provider: "RAZORPAY" } });
    const { event, ticket } = await createEvent();
    const free = await prisma.ticketType.create({ data: { eventId: event.id, name: "Free", priceMinor: BigInt(0) } });
    await buy(event.slug, "cancel-paid", ticket.id);
    await pay("cancel-paid");
    await buy(event.slug, "cancel-free", free.id);
    await buy(event.slug, "cancel-held", ticket.id);

    identity.id = owner;
    expect(await deleteEvent({ organisationSlug: orgSlug, eventId: event.id })).toMatchObject({ ok: false, error: expect.stringContaining("still holds money") });
    expect(await cancelEvent({ organisationSlug: orgSlug, eventId: event.id, reason: "Venue closed" })).toMatchObject({ ok: true, data: { refunded: 1, failed: 0, notified: 3 } });
    // Running it again finishes nothing new.
    expect(await cancelEvent({ organisationSlug: orgSlug, eventId: event.id })).toMatchObject({ ok: true, data: { refunded: 0, notified: 0 } });
    identity.id = "";

    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(EventStatus.CANCELLED);
    const paid = await orderOf("cancel-paid");
    expect(paid.status).toBe(OrderStatus.CANCELLED);
    expect(await prisma.paymentRefund.findMany({ where: { payment: { orderId: paid.id } }, select: { amountMinor: true } })).toEqual([{ amountMinor: BigInt(49900) }]);
    expect((await orderOf("cancel-held")).holdExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    // Everyone is told the event is off: free guests, buyers being refunded, and buyers still paying.
    for (const who of ["cancel-free", "cancel-paid", "cancel-held"]) {
      expect(await prisma.outboxMessage.count({ where: { kind: "operator-notice", payload: { path: ["to"], equals: email(who) } } })).toBe(1);
    }
  });
});
