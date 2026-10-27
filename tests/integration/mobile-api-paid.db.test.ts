import { randomUUID } from "node:crypto";
import { EventPrivacyType, OrderStatus, PaymentStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Paid tickets through the mobile API: a paid place is never confirmed
 * unpaid, a paid ticket isn't cancelled outside its order, organiser
 * decisions offer payment links, and orders stay with their buyer and event.
 */

process.env.REDIS_URL = "";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";

vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `192.0.2.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));

import { prisma } from "@/lib/db";
import { INSTANCE_SETTINGS_ID } from "@/lib/instanceSettings";
import { encryptPaymentSecret } from "@/lib/payments/secrets";
import { newWebhookPathId } from "@/lib/payments/settings";
import { createFakeProvider, FAKE_PROVIDER_ORIGIN } from "../helpers/fakeProviderFetch";
import { createEvent, createUser, get, params, post, signIn, type SignedIn } from "../helpers/mobileApi";
import { POST as rsvp } from "@/app/api/mobile/v1/rsvp/route";
import { POST as cancelMine } from "@/app/api/mobile/v1/me/registrations/[rsvpId]/cancel/route";
import { GET as myOrder } from "@/app/api/mobile/v1/me/orders/[orderId]/route";
import { GET as myOrders } from "@/app/api/mobile/v1/me/orders/route";
import { POST as reject } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/guests/[rsvpId]/reject/route";
import { POST as reaccept } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/guests/[rsvpId]/reaccept/route";
import { GET as organiserOrder } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/orders/[orderId]/route";
import { POST as preview } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/check-in/preview/route";

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const email = (name: string) => `${name}-${suffix}@example.test`;
const fake = createFakeProvider();
const ids = { org: "", otherOrg: "", event: "", approvalEvent: "", otherEvent: "", ticket: "", approvalTicket: "", owner: "", buyer: "", other: "" };
const orgSlug = `mob-paid-${suffix}`;
let previousPaidEvents: boolean | null = null;
let owner: SignedIn;
let buyer: SignedIn;
let other: SignedIn;

beforeAll(async () => {
  vi.stubEnv("MFA_ENCRYPTION_KEY", process.env.MFA_ENCRYPTION_KEY || Buffer.alloc(32, 9).toString("base64"));
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "http://127.0.0.1:3999");
  vi.stubEnv("PAYMENTS_FAKE_PROVIDER_URL", FAKE_PROVIDER_ORIGIN);
  vi.stubGlobal("fetch", fake.fetch);
  ids.org = (await prisma.organisation.create({ data: { name: "Paid mobile", slug: orgSlug } })).id;
  ids.otherOrg = (await prisma.organisation.create({ data: { name: "Other paid", slug: `mob-paid-other-${suffix}` } })).id;
  await prisma.organisationPaymentSettings.create({ data: {
    organisationId: ids.org, provider: "RAZORPAY", webhookPathId: newWebhookPathId(), razorpayKeyId: "rzp_test_abcdef",
    razorpayKeySecretEncrypted: encryptPaymentSecret(ids.org, "razorpayKeySecretEncrypted", "secretvalue"),
    razorpayWebhookSecretEncrypted: encryptPaymentSecret(ids.org, "razorpayWebhookSecretEncrypted", `rzp-webhook-${suffix}`),
  } });
  previousPaidEvents = (await prisma.instanceSetting.findUnique({ where: { id: INSTANCE_SETTINGS_ID } }))?.paidEventsEnabled ?? null;
  await prisma.instanceSetting.upsert({ where: { id: INSTANCE_SETTINGS_ID }, create: { id: INSTANCE_SETTINGS_ID, paidEventsEnabled: true }, update: { paidEventsEnabled: true } });
  ids.event = await createEvent(ids.org, `paid-${suffix}`, { currency: "INR", capacity: 10 });
  ids.approvalEvent = await createEvent(ids.org, `paid-approval-${suffix}`, { currency: "INR", capacity: 10, privacyType: EventPrivacyType.APPROVAL_REQUIRED });
  ids.otherEvent = await createEvent(ids.otherOrg, `paid-other-${suffix}`, { currency: "INR" });
  ids.ticket = (await prisma.ticketType.create({ data: { eventId: ids.event, name: "General", priceMinor: BigInt(49900) } })).id;
  ids.approvalTicket = (await prisma.ticketType.create({ data: { eventId: ids.approvalEvent, name: "General", priceMinor: BigInt(49900) } })).id;
  ids.owner = await createUser(email("owner"), "Owner");
  ids.buyer = await createUser(email("buyer"), "Bea Buyer");
  ids.other = await createUser(email("other"), "Otto Other");
  await prisma.membership.create({ data: { userId: ids.owner, organisationId: ids.org, role: "OWNER" } });
  owner = await signIn(email("owner"));
  buyer = await signIn(email("buyer"));
  other = await signIn(email("other"));
});

afterAll(async () => {
  await prisma.organisation.deleteMany({ where: { id: { in: [ids.org, ids.otherOrg] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.buyer, ids.other] } } });
  if (previousPaidEvents === null) await prisma.instanceSetting.updateMany({ where: { id: INSTANCE_SETTINGS_ID }, data: { paidEventsEnabled: false } });
  else await prisma.instanceSetting.update({ where: { id: INSTANCE_SETTINGS_ID }, data: { paidEventsEnabled: previousPaidEvents } });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const at = <T extends Record<string, string>>(eventId: string, extra: T = {} as T) => params({ orgSlug, eventId, ...extra });

describe.sequential("paid tickets through the mobile API", () => {
  it("holds a paid place for payment and never confirms it unpaid", async () => {
    // Buying tickets needs a signed-in buyer.
    const guest = await rsvp(post("/x", { orgSlug, eventSlug: `paid-${suffix}`, name: "Guest", guestEmail: email("guest"), items: [{ ticketTypeId: ids.ticket, quantity: 1 }] }), params({}));
    expect(guest.status).toBe(401);

    const response = await rsvp(post("/x", { orgSlug, eventSlug: `paid-${suffix}`, items: [{ ticketTypeId: ids.ticket, quantity: 1 }] }, buyer.accessToken), params({}));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.data).toMatchObject({ status: "PENDING_PAYMENT", ticketToken: null, orderId: expect.any(String), holdExpiresAt: expect.any(String) });
    expect(body.data.checkoutUrl).toMatch(/^https?:\/\//);
    const held = await prisma.rSVP.findFirstOrThrow({ where: { eventId: ids.event, userId: ids.buyer } });
    expect(held.status).toBe(RsvpStatus.PENDING_PAYMENT);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: body.data.orderId } });
    expect(order.status).toBe(OrderStatus.PENDING);
    // The order's access token never reaches the app.
    expect(JSON.stringify(body)).not.toContain(order.accessToken);

    const mine = await (await myOrder(get("/x", buyer.accessToken), params({ orderId: order.id }))).json();
    expect(mine.data).toMatchObject({ id: order.id, status: "PENDING", holdActive: true, tickets: [expect.objectContaining({ status: "PENDING_PAYMENT", ticketToken: null })] });
    expect(JSON.stringify(mine)).not.toContain(order.accessToken);
    expect(JSON.stringify(mine)).not.toContain(held.checkInToken);
    // Nobody else reaches it.
    expect((await myOrder(get("/x", other.accessToken), params({ orderId: order.id }))).status).toBe(404);
    expect((await (await myOrders(get("/x", other.accessToken), params({}))).json()).data.orders).toEqual([]);

    // The desk sees what is owed, and the organiser of another event does not see the order.
    const desk = await (await preview(post("/x", { rsvpId: held.id }, owner.accessToken), at(ids.event))).json();
    expect(desk.data.payment).toMatchObject({ orderId: order.id, due: expect.stringContaining("499") });
    expect((await organiserOrder(get("/x", owner.accessToken), at(ids.event, { orderId: order.id }))).status).toBe(200);
    expect((await organiserOrder(get("/x", owner.accessToken), at(ids.approvalEvent, { orderId: order.id }))).status).toBe(404);
  });

  it("refuses to cancel a paid ticket outside its order", async () => {
    const held = await prisma.rSVP.findFirstOrThrow({ where: { eventId: ids.event, userId: ids.buyer }, select: { id: true, orderId: true } });
    // Simulate the provider's confirmation: money collected, ticket confirmed.
    await prisma.payment.updateMany({ where: { orderId: held.orderId! }, data: { status: PaymentStatus.PAID_ONLINE, paidAt: new Date(), externalPaymentId: `pay_${suffix}` } });
    await prisma.order.update({ where: { id: held.orderId! }, data: { status: OrderStatus.CONFIRMED, holdExpiresAt: null } });
    await prisma.rSVP.update({ where: { id: held.id }, data: { status: RsvpStatus.CONFIRMED, holdExpiresAt: null } });

    const refused = await cancelMine(post("/x", {}, buyer.accessToken), params({ rsvpId: held.id }));
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ ok: false, error: { code: "PAID_ORDER" } });
    await expect(prisma.rSVP.findUnique({ where: { id: held.id } })).resolves.toMatchObject({ status: RsvpStatus.CONFIRMED });
    // Someone else's ticket is simply not found.
    expect((await cancelMine(post("/x", {}, other.accessToken), params({ rsvpId: held.id }))).status).toBe(404);
  });

  it("answers a paid request as pending approval, and re-accepting it offers a payment link", async () => {
    const requested = await rsvp(post("/x", { orgSlug, eventSlug: `paid-approval-${suffix}`, items: [{ ticketTypeId: ids.approvalTicket, quantity: 1 }] }, other.accessToken), params({}));
    const body = await requested.json();
    expect(body.data).toMatchObject({ status: "PENDING_APPROVAL", ticketToken: null, orderId: expect.any(String), checkoutUrl: null });
    const request = await prisma.rSVP.findFirstOrThrow({ where: { eventId: ids.approvalEvent, userId: ids.other } });

    const declined = await reject(post("/x", {}, owner.accessToken), at(ids.approvalEvent, { rsvpId: request.id }));
    await expect(declined.json()).resolves.toMatchObject({ ok: true, data: { rsvpId: request.id, status: "REJECTED" } });
    const offered = await reaccept(post("/x", {}, owner.accessToken), at(ids.approvalEvent, { rsvpId: request.id }));
    const guest = await offered.json();
    expect(offered.status, JSON.stringify(guest)).toBe(200);
    expect(guest.data).toMatchObject({ rsvpId: request.id, status: "PENDING_PAYMENT", paymentOutcome: "LINK_SENT", orderId: expect.any(String) });
    await expect(prisma.rSVP.findUniqueOrThrow({ where: { id: request.id } })).resolves.toMatchObject({ status: RsvpStatus.PENDING_PAYMENT });
    // Another organisation's organiser can't touch it.
    expect((await reaccept(post("/x", {}, owner.accessToken), params({ orgSlug: `mob-paid-other-${suffix}`, eventId: ids.otherEvent, rsvpId: request.id }))).status).toBe(404);
  });
});
