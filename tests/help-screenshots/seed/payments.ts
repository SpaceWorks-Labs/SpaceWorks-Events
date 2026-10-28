import "./serverOnly";
import { EventPrivacyType, EventStatus, PaymentProvider, PromoAppliesPer, PromoDiscountKind, RefundPolicyKind, TicketPricing, TicketTypeKind, TicketVisibility } from "@prisma/client";
import { encryptPaymentSecret } from "@/lib/payments/secrets";
import { promoCodeDigest, promoCodeHint } from "@/lib/payments/promo";
import { CURRENCY, DAY, HOUR, TIMEZONE, daysFromNow, inr, type Db } from "./common";
import { coverImage, type People } from "./people";

/** Fictional test-mode values: they are encrypted at rest and never sent anywhere. */
const FAKE_RAZORPAY_KEY_ID = "rzp_test_HelpScreens01";

/** Paid events on, a connected (test-mode) Razorpay account, and a ticketed conference. */
export async function seedPaidEvent(prisma: Db, people: People, now: number, series: { id: string }) {
  const { org, owner } = people;
  await prisma.organisationPaymentSettings.create({
    data: {
      organisationId: org.id,
      provider: PaymentProvider.RAZORPAY,
      currency: CURRENCY,
      razorpayKeyId: FAKE_RAZORPAY_KEY_ID,
      razorpayKeySecretEncrypted: encryptPaymentSecret(org.id, "razorpayKeySecretEncrypted", "example-key-secret-for-screenshots"),
      razorpayWebhookSecretEncrypted: encryptPaymentSecret(org.id, "razorpayWebhookSecretEncrypted", "example-webhook-secret-for-screenshots"),
      webhookPathId: "example-webhook-path-help-screens",
      verifiedAt: new Date(now - 2 * DAY),
      receiptLegalName: "Riverside Tech Collective",
      receiptAddress: "12 Quay Street, Riverside",
    },
  });

  const start = daysFromNow(now, 30, 9);
  const summit = await prisma.event.create({
    data: {
      organisationId: org.id,
      title: "Riverside Web Summit 2026",
      slug: "web-summit",
      description: "A full day of talks and workshops on building for the web, with lunch, an expo and an evening social.",
      tags: ["conference", "web"],
      coverImageUrl: await coverImage(prisma, org.id, "#1d4ed8", "#0f766e"),
      startDateTime: start,
      endDateTime: new Date(start.getTime() + 9 * HOUR),
      timezone: TIMEZONE,
      location: "Riverside Corn Exchange, 1 Market Square, Riverside",
      capacity: 300,
      currency: CURRENCY,
      status: EventStatus.PUBLISHED,
      privacyType: EventPrivacyType.PUBLIC,
      refundPolicyKind: RefundPolicyKind.NONE,
      refundPolicyText: "Tickets can be passed to someone else. Ask us if you can no longer come.",
      budgetMinor: inr(60000),
      participantClaimsEnabled: true,
      participantClaimCapMinor: inr(2000),
      createdAt: new Date(now - 40 * DAY),
      page: { create: { isPublished: true, accentColor: "#1d4ed8", tagline: "One day, two tracks, everything web", aboutHtml: "<p>Talks, workshops and an expo for Riverside's web community.</p>" } },
    },
  });

  const type = (data: Omit<Parameters<Db["ticketType"]["create"]>[0]["data"], "eventId">) =>
    prisma.ticketType.create({ data: { eventId: summit.id, ...data } as Parameters<Db["ticketType"]["create"]>[0]["data"] });
  const community = await type({ name: "Community", description: "Free for members of local community groups.", priceMinor: BigInt(0), capacity: 40, maxPerOrder: 1, sortOrder: 0 });
  const standard = await type({ name: "Standard", description: "Entry to every talk and workshop, with lunch.", priceMinor: inr(999), capacity: 200, sortOrder: 1, payAtDesk: true });
  const group = await type({ name: "Team of 4", description: "Four places for one team, at a lower price.", priceMinor: inr(3200), seatsPerTicket: 4, maxPerOrder: 2, sortOrder: 2 });
  const supporter = await type({
    name: "Supporter", description: "Pay what you like and help keep the summit affordable.", pricing: TicketPricing.FLEXIBLE,
    priceMinor: inr(500), suggestedMinor: inr(1500), maxPriceMinor: inr(10000), maxPerOrder: 2, sortOrder: 3,
  });
  const crew = await type({
    name: "Speakers and crew", description: "For speakers and volunteers, with the code we sent you.", visibility: TicketVisibility.CODE,
    accessCodeDigest: promoCodeDigest("CREW2026"), accessCodeHint: promoCodeHint("CREW2026"), priceMinor: BigInt(0), maxPerOrder: 1, sortOrder: 4,
  });

  const tshirt = await prisma.addOn.create({ data: { eventId: summit.id, name: "Summit T-shirt", description: "Organic cotton, collected at the desk.", priceMinor: inr(600), capacity: 120, maxPerOrder: 3, sortOrder: 0 } });
  const social = await prisma.addOn.create({ data: { eventId: summit.id, name: "Evening social", description: "Dinner and drinks after the talks.", priceMinor: inr(750), capacity: 80, maxPerOrder: 4, sortOrder: 1 } });

  const earlyBird = await prisma.promoCode.create({
    data: {
      eventId: summit.id, codeDigest: promoCodeDigest("EARLYBIRD"), hint: promoCodeHint("EARLYBIRD"), kind: PromoDiscountKind.PERCENT, percentOff: 20,
      appliesPer: PromoAppliesPer.TICKET, maxRedemptions: 50, validUntil: new Date(now + 10 * DAY), createdByUserId: owner.id,
    },
  });
  await prisma.promoCode.create({
    data: {
      eventId: summit.id, codeDigest: promoCodeDigest("STUDENT100"), hint: promoCodeHint("STUDENT100"), kind: PromoDiscountKind.FIXED, amountOffMinor: inr(100),
      appliesPer: PromoAppliesPer.TICKET, ticketTypeId: standard.id, createdByUserId: owner.id,
    },
  });

  // A season pass for the weekly series.
  await prisma.eventSeries.update({ where: { id: series.id }, data: { currency: CURRENCY } });
  await prisma.ticketType.create({
    data: { eventSeriesId: series.id, kind: TicketTypeKind.PASS, name: "Season pass", description: "A place at every remaining Code Club.", priceMinor: inr(1200), sortOrder: 0 },
  });
  await prisma.ticketType.create({ data: { eventSeriesId: series.id, name: "Drop-in", priceMinor: inr(400), sortOrder: 1 } });

  return { summit, types: { community, standard, group, supporter, crew }, addOns: { tshirt, social }, earlyBird };
}

export type PaidEvent = Awaited<ReturnType<typeof seedPaidEvent>>;
