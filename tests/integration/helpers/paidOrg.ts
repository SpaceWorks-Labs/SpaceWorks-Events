import { randomUUID } from "node:crypto";
import { EventStatus, RegistrationMode, SoloPolicy, TeamTicketMode, type EventPrivacyType } from "@prisma/client";
import { vi } from "vitest";
import { prisma } from "@/lib/db";
import { INSTANCE_SETTINGS_ID } from "@/lib/instanceSettings";
import { encryptPaymentSecret } from "@/lib/payments/secrets";
import { newWebhookPathId } from "@/lib/payments/settings";
import { settlePaidNotification } from "@/lib/payments/settlement";
import { createFakeProvider, FAKE_PROVIDER_ORIGIN } from "../../helpers/fakeProviderFetch";

/*
 * A paid organisation on the fake Razorpay for the Phase 2 suites (paid teams,
 * entry fees, prizes, add-on lists). Each suite gets its own organisation; call
 * setUpPaidOrg / tearDownPaidOrg from beforeAll / afterAll after mocking
 * `@/lib/auth`.
 */

export const fake = createFakeProvider();
export const paid = { suffix: randomUUID().replace(/-/g, ""), organisationId: "", orgSlug: "" };
let previousPaidEvents: boolean | null = null;
let counter = 0;

export async function setUpPaidOrg(name: string) {
  vi.stubEnv("MFA_ENCRYPTION_KEY", process.env.MFA_ENCRYPTION_KEY || Buffer.alloc(32, 9).toString("base64"));
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "http://127.0.0.1:3999");
  vi.stubEnv("PAYMENTS_FAKE_PROVIDER_URL", FAKE_PROVIDER_ORIGIN);
  vi.stubGlobal("fetch", fake.fetch);
  const organisation = await prisma.organisation.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${paid.suffix}` } });
  paid.organisationId = organisation.id;
  paid.orgSlug = organisation.slug;
  await prisma.organisationPaymentSettings.create({ data: {
    organisationId: organisation.id, provider: "RAZORPAY", webhookPathId: newWebhookPathId(), razorpayKeyId: "rzp_test_abcdef",
    razorpayKeySecretEncrypted: encryptPaymentSecret(organisation.id, "razorpayKeySecretEncrypted", "secretvalue"),
    razorpayWebhookSecretEncrypted: encryptPaymentSecret(organisation.id, "razorpayWebhookSecretEncrypted", `rzp-webhook-${paid.suffix}`),
  } });
  previousPaidEvents = (await prisma.instanceSetting.findUnique({ where: { id: INSTANCE_SETTINGS_ID } }))?.paidEventsEnabled ?? null;
  await prisma.instanceSetting.upsert({ where: { id: INSTANCE_SETTINGS_ID }, create: { id: INSTANCE_SETTINGS_ID, paidEventsEnabled: true }, update: { paidEventsEnabled: true } });
}

export async function tearDownPaidOrg() {
  await prisma.organisation.deleteMany({ where: { id: paid.organisationId } });
  if (previousPaidEvents === null) await prisma.instanceSetting.updateMany({ where: { id: INSTANCE_SETTINGS_ID }, data: { paidEventsEnabled: false } });
  else await prisma.instanceSetting.update({ where: { id: INSTANCE_SETTINGS_ID }, data: { paidEventsEnabled: previousPaidEvents } });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await prisma.$disconnect();
}

/** A published team event selling one ticket (49900 paise unless `price`). */
export async function createTeamEvent(options: { mode?: TeamTicketMode; capacity?: number | null; privacyType?: EventPrivacyType; price?: number; soloPolicy?: SoloPolicy; } = {}) {
  counter += 1;
  const event = await prisma.event.create({ data: {
    organisationId: paid.organisationId, title: `Paid teams ${counter}`, slug: `paid-teams-${paid.suffix}-${counter}`, currency: "INR",
    startDateTime: new Date("2035-01-01T10:00:00.000Z"), endDateTime: new Date("2035-01-02T10:00:00.000Z"), timezone: "UTC",
    capacity: options.capacity ?? null, status: EventStatus.PUBLISHED, ...(options.privacyType ? { privacyType: options.privacyType } : {}),
    registrationMode: RegistrationMode.TEAM, teamMaxSize: 3, soloPolicy: options.soloPolicy ?? SoloPolicy.SOLO_ALLOWED, teamTicketMode: options.mode ?? TeamTicketMode.PER_MEMBER,
    page: { create: { isPublished: true } },
  } });
  const ticket = await prisma.ticketType.create({ data: { eventId: event.id, name: "Entry", priceMinor: BigInt(options.price ?? 49900), maxPerOrder: 1 } });
  return { event, ticket };
}

/** Settle an order's open checkout page as the provider would report it. */
export async function payOrder(orderId: string, now?: Date) {
  const attempt = await prisma.paymentCheckoutAttempt.findFirstOrThrow({ where: { payment: { orderId } }, orderBy: { createdAt: "desc" } });
  return prisma.$transaction((tx) => settlePaidNotification(tx, { organisationId: paid.organisationId, provider: "RAZORPAY" }, {
    checkoutId: attempt.externalId, reference: attempt.id, paymentId: `pay_${attempt.id}`, amountMinor: null, currency: null,
  }, now));
}
