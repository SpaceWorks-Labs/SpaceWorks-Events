import { EventPrivacyType, EventStatus, RsvpStatus, TicketTypeKind, type Prisma } from "@prisma/client";
import { expect } from "vitest";
import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { paid, setUpPaidOrg, tearDownPaidOrg } from "./paidOrg";

/*
 * Fixtures for the payment audit suites (docs/PAYMENTS.md): an organisation
 * on the fake Razorpay with a verified owner, one-off events and series that
 * sell online tickets, and buyers whose orders wait for payment.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let counter = 0;
export const owner = { id: "", email: "" };
export const email = (name: string) => `${name}-${paid.suffix}@example.test`;

export async function setUpPaymentAudit(name: string) {
  await setUpPaidOrg(name);
  owner.email = email("owner");
  owner.id = (await prisma.user.create({ data: { email: owner.email, name: "Owner", emailVerified: new Date(), memberships: { create: { organisationId: paid.organisationId, role: "OWNER" } } } })).id;
}

export async function tearDownPaymentAudit() {
  await prisma.$executeRaw`DELETE FROM "OutboxMessage" WHERE "payload"->>'to' LIKE ${`%${paid.suffix}@example.test`}`;
  await prisma.user.deleteMany({ where: { email: { endsWith: `${paid.suffix}@example.test` } } });
  await tearDownPaidOrg();
}

/** A published one-off event selling one online ticket (49900 paise unless `price`). */
export async function onlineEvent(options: { capacity?: number | null; privacyType?: EventPrivacyType; price?: number; } = {}) {
  counter += 1;
  const start = new Date(Date.now() + 30 * DAY);
  const event = await prisma.event.create({ data: {
    organisationId: paid.organisationId, title: `Audit event ${counter}`, slug: `audit-${paid.suffix}-${counter}`, currency: "INR", capacity: options.capacity ?? null,
    startDateTime: start, endDateTime: new Date(start.getTime() + 2 * HOUR), timezone: "UTC", status: EventStatus.PUBLISHED, page: { create: { isPublished: true } },
    ...(options.privacyType ? { privacyType: options.privacyType } : {}),
  } });
  const ticket = await prisma.ticketType.create({ data: { eventId: event.id, name: "General", priceMinor: BigInt(options.price ?? 49900) } });
  return { event, ticket };
}

/** A published series with three dates ahead, a drop-in ticket and a pass. */
export async function onlineSeries(options: { capacity?: number | null; } = {}) {
  counter += 1;
  const series = await prisma.eventSeries.create({ data: {
    organisationId: paid.organisationId, title: `Audit course ${counter}`, slug: `audit-course-${paid.suffix}-${counter}`, recurrenceRule: "FREQ=WEEKLY;COUNT=3",
    timezone: "UTC", status: EventStatus.PUBLISHED, capacity: options.capacity ?? null, currency: "INR",
  } });
  const dates = [];
  for (const offset of [7, 14, 21]) {
    dates.push(await prisma.eventInstance.create({ data: { eventSeriesId: series.id, startDateTime: new Date(Date.now() + offset * DAY), endDateTime: new Date(Date.now() + offset * DAY + 2 * HOUR) } }));
  }
  const single = await prisma.ticketType.create({ data: { eventSeriesId: series.id, name: "Drop-in", priceMinor: BigInt(30000) } });
  const pass = await prisma.ticketType.create({ data: { eventSeriesId: series.id, kind: TicketTypeKind.PASS, name: "Course pass", priceMinor: BigInt(90000) } });
  return { series, dates: dates as [typeof dates[number], typeof dates[number], typeof dates[number]], single, pass };
}

type Target = { eventSlug: string; } | { eventInstanceId: string; };

/** Order online: the order is held while the buyer pays on the fake provider's page. */
export async function buyOnline(target: Target, ticketTypeId: string, buyer: string, extra: { quantity?: number; addOns?: Array<{ addOnId: string; quantity: number; }>; } = {}) {
  const result = await submitRsvpCore({
    orgSlug: paid.orgSlug, ...target, guestEmail: email(buyer), name: "Paying Guest", answers: {}, attendees: [],
    items: [{ ticketTypeId, quantity: extra.quantity ?? 1 }], ...(extra.addOns ? { addOns: extra.addOns } : {}),
  }, { userId: null });
  expect(result).toMatchObject({ ok: true });
  return prisma.order.findFirstOrThrow({ where: { buyerEmail: email(buyer) }, include: { rsvps: true, payments: { include: { refunds: true } } }, orderBy: { createdAt: "desc" } });
}

/** A free event's confirmed registration, or a waitlisted one. */
export async function freeRsvp(eventId: string, name: string, status: RsvpStatus) {
  return prisma.rSVP.create({ data: { eventId, guestEmail: email(name), guestName: name, attendeeKey: `guest:${email(name)}`, status } });
}

export const paymentNotices = (paymentId: string, notice: string) => prisma.outboxMessage.count({ where: { kind: "payment-notice", AND: [{ payload: { path: ["paymentId"], equals: paymentId } }, { payload: { path: ["notice"], equals: notice } }] } });

/**
 * Start `work` while another transaction holds a row lock (`lock` runs a FOR
 * UPDATE), so everything in `work` queues behind it; then let it go. Makes a
 * race's operations contend for the same rows instead of running one by one.
 */
export async function whileLocked<T>(lock: (tx: Prisma.TransactionClient) => Promise<unknown>, work: () => Promise<T>, holdMs = 300) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => { locked = resolve; });
  const holder = prisma.$transaction(async (tx) => {
    await lock(tx);
    locked();
    await released;
  }, { timeout: 15_000 });
  await isLocked;
  const running = work();
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  release();
  await holder;
  return running;
}
