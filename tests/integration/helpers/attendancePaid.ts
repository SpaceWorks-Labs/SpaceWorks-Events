import { EventStatus, type RefundPolicyKind } from "@prisma/client";
import { expect } from "vitest";
import { prisma } from "@/lib/db";
import { sendAttendanceChecksForUser } from "@/lib/core/attendanceCheck";
import { settleOrderByHand } from "@/lib/payments/operations";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { hashAttendanceToken } from "@/lib/attendanceToken";
import { paid, setUpPaidOrg, tearDownPaidOrg } from "./paidOrg";

/*
 * Paid-ticket fixtures for the attendance suites (docs/ATTENDANCE.md): an
 * organisation on the fake provider with a verified owner, events selling a
 * pay-at-the-desk ticket, and orders confirmed with the money owed or
 * collected in person.
 */

const HOUR = 3_600_000;
let counter = 0;
export const owner = { id: "", email: "" };
export const email = (name: string) => `${name}-${paid.suffix}@example.test`;

export async function setUpPaidAttendance(name: string) {
  await setUpPaidOrg(name);
  owner.email = email("owner");
  owner.id = (await prisma.user.create({ data: { email: owner.email, name: "Owner", emailVerified: new Date(), memberships: { create: { organisationId: paid.organisationId, role: "OWNER" } } } })).id;
}

export async function tearDownPaidAttendance() {
  await prisma.$executeRaw`DELETE FROM "OutboxMessage" WHERE "payload"->>'to' LIKE ${`%${paid.suffix}@example.test`}`;
  await prisma.user.deleteMany({ where: { email: { endsWith: `${paid.suffix}@example.test` } } });
  await tearDownPaidOrg();
}

export async function paidEvent(policy: { kind: RefundPolicyKind; hours?: number; percent?: number; }, release = true) {
  counter += 1;
  const start = new Date(Date.now() + 30 * 24 * HOUR);
  const event = await prisma.event.create({ data: {
    organisationId: paid.organisationId, title: `Paid attendance ${counter}`, slug: `paid-att-${paid.suffix}-${counter}`, currency: "INR", capacity: 50,
    startDateTime: start, endDateTime: new Date(start.getTime() + 2 * HOUR), timezone: "UTC", status: EventStatus.PUBLISHED, page: { create: { isPublished: true } },
    refundPolicyKind: policy.kind, refundPolicyHours: policy.hours ?? null, refundPolicyPercent: policy.percent ?? null, attendanceCheckReleaseOnDecline: release,
  } });
  const ticket = await prisma.ticketType.create({ data: { eventId: event.id, name: "General", priceMinor: BigInt(49900), payAtDesk: true } });
  return { event, ticket };
}

/** Reserve at the desk: a confirmed order with its payment still owed (PENDING). */
export async function buyAtDesk(event: { id: string; slug: string; }, ticketTypeId: string, buyer: string, friends: string[] = []) {
  const result = await submitRsvpCore({
    orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: email(buyer), name: "Paying Guest", answers: {}, payAtDesk: true,
    items: [{ ticketTypeId, quantity: 1 + friends.length }], attendees: friends.map((friend) => ({ name: "Friend", email: email(friend) })),
  }, { userId: null });
  expect(result).toMatchObject({ ok: true });
  return prisma.order.findFirstOrThrow({ where: { eventId: event.id, buyerEmail: email(buyer) }, include: { rsvps: true } });
}

/** Buy at the desk and record the money as collected in person: a confirmed, paid order. */
export async function buyPaid(event: { id: string; slug: string; }, ticketTypeId: string, buyer: string, friends: string[] = []) {
  const order = await buyAtDesk(event, ticketTypeId, buyer, friends);
  await settleOrderByHand({ orderId: order.id, organisationId: paid.organisationId, actorUserId: owner.id, mode: "offline", method: "CASH" });
  return order;
}

export async function askAndToken(event: { id: string; }, rsvpId: string) {
  await sendAttendanceChecksForUser(owner.id, { organisationSlug: paid.orgSlug, eventId: event.id });
  const check = await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId } });
  const messages = await prisma.outboxMessage.findMany({ where: { kind: "attendance-check", payload: { path: ["rsvpId"], equals: rsvpId } } });
  return messages.map((message) => (message.payload as { token: string }).token).find((raw) => hashAttendanceToken(raw) === check.tokenHash)!;
}

export const noticesTo = (to: string, subject: string) => prisma.outboxMessage.count({ where: { kind: "operator-notice", AND: [{ payload: { path: ["to"], equals: to } }, { payload: { path: ["subject"], string_contains: subject } }] } });
