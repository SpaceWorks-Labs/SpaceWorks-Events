import { EventStatus, OrderStatus, RsvpStatus, SubmissionStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));

import { prisma } from "@/lib/db";
import { commitListCheckIn } from "@/lib/checkInListMutations";
import { disqualifySubmission, submitSubmission, withdrawSubmission, type EntrantAuth } from "@/lib/core/judging";
import { recordPrizePayout, reversePrizePayout, setAwardPrize } from "@/lib/prizes";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { paid, payOrder, setUpPaidOrg, tearDownPaidOrg } from "./helpers/paidOrg";

/*
 * Phase 2 paid options beyond teams: hackathon entry fees (docs/HACKATHON.md),
 * prize payouts in an append-only ledger, and check-in lists for the buyers
 * of an extra (docs/PAYMENTS.md).
 */

let counter = 0;
const HOUR = 3_600_000;

async function hackathon(fee: number | null) {
  counter += 1;
  return prisma.event.create({ data: {
    organisationId: paid.organisationId, title: `Hackathon ${counter}`, slug: `hack-${paid.suffix}-${counter}`, currency: "INR",
    startDateTime: new Date(Date.now() - HOUR), endDateTime: new Date(Date.now() + 48 * HOUR), timezone: "UTC", status: EventStatus.PUBLISHED,
    submissionsEnabled: true, submissionsOpenAt: new Date(Date.now() - HOUR), submissionsCloseAt: new Date(Date.now() + 24 * HOUR),
    submissionFeeMinor: fee == null ? null : BigInt(fee), page: { create: { isPublished: true } },
  } });
}

async function soloEntrant(eventId: string, label: string): Promise<EntrantAuth & { kind: "solo-owner" }> {
  const user = await prisma.user.create({ data: { email: `${label}-${paid.suffix}@example.test`, name: `Entrant ${label}` } });
  const rsvp = await prisma.rSVP.create({ data: { eventId, userId: user.id, attendeeKey: `user:${user.id}`, status: RsvpStatus.CONFIRMED } });
  return { kind: "solo-owner", eventId, rsvpId: rsvp.id, userId: user.id };
}

async function organiser(eventId: string) {
  const user = await prisma.user.create({ data: { email: `organiser-${counter}-${paid.suffix}@example.test` } });
  return { userId: user.id, organisationId: paid.organisationId, orgSlug: paid.orgSlug, eventId, eventSlug: "" };
}

beforeAll(() => setUpPaidOrg("Paid extras"));
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `${paid.suffix}@example.test` } } });
  await tearDownPaidOrg();
});

describe.sequential("entry fees", () => {
  it("keeps the project a draft until the fee is paid, then submits it once", async () => {
    const event = await hackathon(25000);
    const entrant = await soloEntrant(event.id, "fee-a");
    const first = await submitSubmission(entrant, { title: "Rocket telemetry" });
    expect(first).toMatchObject({ ok: true, data: { status: SubmissionStatus.DRAFT, checkoutUrl: expect.stringMatching(/^https:/) } });
    const submission = await prisma.submission.findFirstOrThrow({ where: { eventId: event.id } });
    const order = await prisma.order.findFirstOrThrow({ where: { submissionId: submission.id }, include: { lines: true, rsvps: true } });
    expect(order).toMatchObject({ status: OrderStatus.PENDING, totalMinor: BigInt(25000) });
    expect(order.rsvps).toHaveLength(0);

    expect((await payOrder(order.id)).outcome).toBe("confirmed");
    expect(await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } })).toMatchObject({ status: SubmissionStatus.SUBMITTED });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: OrderStatus.CONFIRMED });

    // Withdrawn and submitted again: already paid for.
    expect(await withdrawSubmission(entrant)).toMatchObject({ ok: true });
    expect(await submitSubmission(entrant, { title: "Rocket telemetry v2" })).toMatchObject({ ok: true, data: { status: SubmissionStatus.SUBMITTED } });
    expect(await prisma.order.count({ where: { submissionId: submission.id } })).toBe(1);
  });

  it("refunds the fee in full when the project is disqualified", async () => {
    const event = await hackathon(30000);
    const entrant = await soloEntrant(event.id, "fee-b");
    await submitSubmission(entrant, { title: "Weather balloon" });
    const submission = await prisma.submission.findFirstOrThrow({ where: { eventId: event.id } });
    await payOrder((await prisma.order.findFirstOrThrow({ where: { submissionId: submission.id } })).id);
    expect(await disqualifySubmission(await organiser(event.id), { submissionId: submission.id, reason: "Plagiarised" })).toMatchObject({ ok: true });
    const refunds = await prisma.paymentRefund.findMany({ where: { payment: { order: { submissionId: submission.id } } } });
    expect(refunds.map((refund) => refund.amountMinor)).toEqual([BigInt(30000)]);
  });
});

describe.sequential("prize payouts", () => {
  it("records payouts up to the prize, reverses them, and refuses edits in the database", async () => {
    const event = await hackathon(null);
    const entrant = await soloEntrant(event.id, "prize-a");
    await submitSubmission(entrant, { title: "Solar sail" });
    const submission = await prisma.submission.findFirstOrThrow({ where: { eventId: event.id } });
    const award = await prisma.eventAward.create({ data: { eventId: event.id, name: "Best hack" } });
    const ctx = { organisationId: paid.organisationId, eventId: event.id, userId: (await organiser(event.id)).userId };
    const payout = (amount: string) => recordPrizePayout(ctx, { awardId: award.id, submissionId: submission.id, recipientName: "Entrant prize-a", amount, method: "BANK_TRANSFER", reference: "UTR123" });

    expect(await payout("100")).toMatchObject({ ok: false, error: expect.stringContaining("hasn't won") });
    await prisma.eventAwardWinner.create({ data: { awardId: award.id, submissionId: submission.id } });
    expect(await setAwardPrize(ctx, { awardId: award.id, prize: "1000" })).toEqual({ ok: true });
    expect(await payout("600")).toEqual({ ok: true });
    expect(await payout("500")).toMatchObject({ ok: false, error: expect.stringContaining("more than the prize") });

    const original = await prisma.prizePayout.findFirstOrThrow({ where: { eventId: event.id } });
    expect(original).toMatchObject({ amountMinor: BigInt(60000), currency: "INR", awardName: "Best hack", projectTitle: "Solar sail" });
    await expect(prisma.prizePayout.update({ where: { id: original.id }, data: { amountMinor: BigInt(1) } })).rejects.toThrow();
    await expect(prisma.prizePayout.create({ data: { ...original, id: undefined, reversesId: original.id, amountMinor: BigInt(1) } })).rejects.toThrow();

    expect(await reversePrizePayout(ctx, { payoutId: original.id, reason: "Wrong account" })).toEqual({ ok: true });
    expect(await reversePrizePayout(ctx, { payoutId: original.id, reason: "Again" })).toMatchObject({ ok: false });
    // Reversed, so the full prize can be paid again.
    expect(await payout("1000")).toEqual({ ok: true });
  });
});

describe.sequential("check-in lists for an extra", () => {
  it("admits the buyers only, as many times as their order bought it", async () => {
    counter += 1;
    const event = await prisma.event.create({ data: {
      organisationId: paid.organisationId, title: `Meals ${counter}`, slug: `meals-${paid.suffix}-${counter}`, currency: "INR",
      startDateTime: new Date("2035-01-01T10:00:00.000Z"), endDateTime: new Date("2035-01-01T12:00:00.000Z"), timezone: "UTC",
      status: EventStatus.PUBLISHED, page: { create: { isPublished: true } },
    } });
    const ticket = await prisma.ticketType.create({ data: { eventId: event.id, name: "Day pass", priceMinor: BigInt(0) } });
    const lunch = await prisma.addOn.create({ data: { eventId: event.id, name: "Lunch", priceMinor: BigInt(25000) } });
    const buyer = `lunch-${paid.suffix}@example.test`;
    const bought = await submitRsvpCore({
      orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: buyer, name: "Lunch Buyer", answers: {},
      items: [{ ticketTypeId: ticket.id, quantity: 2 }], attendees: [{ name: "Friend", email: `friend-${paid.suffix}@example.test` }], addOns: [{ addOnId: lunch.id, quantity: 1 }],
    }, { userId: null });
    expect(bought).toMatchObject({ ok: true });
    const order = await prisma.order.findFirstOrThrow({ where: { buyerEmail: buyer }, include: { rsvps: { orderBy: { createdAt: "asc" } } } });
    await payOrder(order.id);
    await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: `nolunch-${paid.suffix}@example.test`, name: "No Lunch", answers: {}, items: [{ ticketTypeId: ticket.id, quantity: 1 }] }, { userId: null });
    const other = await prisma.rSVP.findFirstOrThrow({ where: { guestEmail: `nolunch-${paid.suffix}@example.test` } });
    const list = await prisma.checkInList.create({ data: { eventId: event.id, name: "Lunch", addOnId: lunch.id } });
    const scan = (rsvpId: string) => commitListCheckIn({ listId: list.id, rsvpId, actorUserId: null, source: "online", checkedInAt: new Date(), force: false });

    expect(await scan(order.rsvps[0]!.id)).toMatchObject({ state: "checked-in" });
    expect(await scan(order.rsvps[1]!.id)).toMatchObject({ state: "ineligible", gate: { reason: expect.stringContaining("bought 1 Lunch") } });
    expect(await scan(other.id)).toMatchObject({ state: "ineligible", gate: { reason: "This list is for guests who bought Lunch." } });
  });
});
