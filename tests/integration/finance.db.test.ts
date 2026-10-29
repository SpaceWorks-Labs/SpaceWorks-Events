import { EventStatus, ExpenseClaimStatus, RefundRequestStatus, RsvpStatus } from "@prisma/client";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
// Receipts use the database store: CI names an S3 bucket but has no credentials.
vi.stubEnv("S3_BUCKET", "");

import { prisma } from "@/lib/db";
import { approveClaim, recordClaimPayout, rejectClaim, reverseClaimPayout } from "@/lib/claims/decide";
import { submitParticipantClaim, submitStaffClaim, withdrawClaim } from "@/lib/claims/submit";
import { loadEventFinance } from "@/lib/finance";
import { decideRefundRequest, requestRefund } from "@/lib/refundRequests";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { downloadReceipt } from "@/lib/storage/private";
import { paid, payOrder, setUpPaidOrg, tearDownPaidOrg } from "./helpers/paidOrg";

/*
 * docs/FINANCE.md: expense claims from staff and participants (with private
 * receipts and a per-person cap), the append-only claim payout ledger, refund
 * requests, and the event's money summary.
 */

let counter = 0;
let staff = { id: "", email: "" };

async function financeEvent(options: { participantClaims?: boolean; cap?: number; price?: number; } = {}) {
  counter += 1;
  const event = await prisma.event.create({ data: {
    organisationId: paid.organisationId, title: `Finance ${counter}`, slug: `finance-${paid.suffix}-${counter}`, currency: "INR",
    startDateTime: new Date("2035-01-01T10:00:00.000Z"), endDateTime: new Date("2035-01-01T12:00:00.000Z"), timezone: "UTC", status: EventStatus.PUBLISHED,
    participantClaimsEnabled: options.participantClaims ?? false, participantClaimCapMinor: options.cap == null ? null : BigInt(options.cap), budgetMinor: BigInt(500000),
    page: { create: { isPublished: true } },
  } });
  const ticket = await prisma.ticketType.create({ data: { eventId: event.id, name: "Entry", priceMinor: BigInt(options.price ?? 0) } });
  return { event, ticket };
}

const admin = () => ({ userId: staff.id, organisationId: paid.organisationId });
const png = async () => new File([new Uint8Array(await sharp({ create: { width: 40, height: 30, channels: 3, background: "#ffffff" } }).png().toBuffer())], "receipt.png", { type: "image/png" });

beforeAll(async () => {
  await setUpPaidOrg("Finance");
  const user = await prisma.user.create({ data: { email: `staff-${paid.suffix}@example.test`, name: "Staff Person" } });
  staff = { id: user.id, email: user.email! };
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `${paid.suffix}@example.test` } } });
  await tearDownPaidOrg();
});

describe.sequential("expense claims", () => {
  it("takes a staff claim with a private receipt, approves part of it, pays and reverses it", async () => {
    const { event } = await financeEvent();
    const claimed = await submitStaffClaim({ userId: staff.id, organisationId: paid.organisationId, eventId: event.id }, { category: "TRAVEL", description: "Train to the venue", amount: "1500", payeeName: "Guest Speaker", payeeEmail: `speaker-${paid.suffix}@example.test` }, [await png()]);
    expect(claimed).toMatchObject({ ok: true });
    const claim = await prisma.expenseClaim.findFirstOrThrow({ where: { eventId: event.id }, include: { receipts: true } });
    expect(claim).toMatchObject({ kind: "STAFF", status: ExpenseClaimStatus.SUBMITTED, amountMinor: BigInt(150000), payeeName: "Guest Speaker", submittedByUserId: staff.id });
    expect(claim.receipts).toHaveLength(1);
    expect(claim.receipts[0]!.storageKey).toMatch(new RegExp(`^organisations/${paid.organisationId}/claim-receipts/[0-9a-f-]{36}\\.webp$`));
    expect((await downloadReceipt(claim.receipts[0]!.storageKey))?.length).toBeGreaterThan(0);

    expect(await approveClaim(admin(), { claimId: claim.id, amount: "2000" })).toMatchObject({ ok: false });
    expect(await approveClaim(admin(), { claimId: claim.id, amount: "1200", note: "Standard fare" })).toEqual({ ok: true, data: undefined });
    expect(await withdrawClaim(claim.id, { userId: staff.id, organisationId: paid.organisationId, eventId: event.id })).toMatchObject({ ok: false });
    expect(await recordClaimPayout(admin(), { claimId: claim.id, method: "UPI", reference: "UPI-1" })).toEqual({ ok: true, data: undefined });
    expect(await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ status: ExpenseClaimStatus.PAID, approvedMinor: BigInt(120000) });
    const payout = await prisma.claimPayout.findFirstOrThrow({ where: { claimId: claim.id } });
    await expect(prisma.claimPayout.update({ where: { id: payout.id }, data: { amountMinor: BigInt(1) } })).rejects.toThrow();

    expect((await loadEventFinance(event.id, paid.organisationId))?.summary).toMatchObject({ expensesPaid: expect.stringContaining("1,200"), net: expect.stringContaining("1,200") });
    expect(await reverseClaimPayout(admin(), { payoutId: payout.id, reason: "Paid the wrong person" })).toEqual({ ok: true, data: undefined });
    expect(await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ status: ExpenseClaimStatus.APPROVED });
    expect(await reverseClaimPayout(admin(), { payoutId: payout.id, reason: "Again" })).toMatchObject({ ok: false });
  });

  it("lets confirmed participants claim up to the cap, only when the event allows it", async () => {
    const closed = await financeEvent();
    const { event } = await financeEvent({ participantClaims: true, cap: 100000 });
    const rsvp = await prisma.rSVP.create({ data: { eventId: event.id, guestEmail: `p-${paid.suffix}@example.test`, guestName: "Participant", attendeeKey: `guest:p-${paid.suffix}@example.test`, status: RsvpStatus.CONFIRMED } });
    const elsewhere = await prisma.rSVP.create({ data: { eventId: closed.event.id, guestEmail: `q-${paid.suffix}@example.test`, attendeeKey: `guest:q-${paid.suffix}@example.test`, status: RsvpStatus.CONFIRMED } });
    const claim = (token: string, amount: string) => submitParticipantClaim({ ticketToken: token, actorUserId: null }, { category: "TRAVEL", description: "Bus fare", amount }, []);

    expect(await claim(elsewhere.checkInToken, "100")).toMatchObject({ ok: false, error: expect.stringContaining("doesn't take") });
    expect(await claim(rsvp.checkInToken, "600")).toMatchObject({ ok: true });
    expect(await claim(rsvp.checkInToken, "500")).toMatchObject({ ok: false, error: expect.stringContaining("is left") });
    const first = await prisma.expenseClaim.findFirstOrThrow({ where: { rsvpId: rsvp.id } });
    expect(await rejectClaim(admin(), { claimId: first.id, note: "No ticket stub" })).toEqual({ ok: true, data: undefined });
    expect(await claim(rsvp.checkInToken, "1000")).toMatchObject({ ok: true });
    const second = await prisma.expenseClaim.findFirstOrThrow({ where: { rsvpId: rsvp.id, status: ExpenseClaimStatus.SUBMITTED } });
    expect(await withdrawClaim(second.id, { rsvpId: rsvp.id })).toEqual({ ok: true, data: undefined });
  });
});

describe.sequential("refund requests", () => {
  it("lets a buyer ask once, and refunds part of the order when approved", async () => {
    const { event, ticket } = await financeEvent({ price: 80000 });
    const buyer = `refund-${paid.suffix}@example.test`;
    await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: buyer, name: "Refund Buyer", answers: {}, items: [{ ticketTypeId: ticket.id, quantity: 1 }] }, { userId: null });
    const order = await prisma.order.findFirstOrThrow({ where: { buyerEmail: buyer } });
    expect(await requestRefund(order.accessToken, "Can't travel")).toMatchObject({ ok: false, error: expect.stringContaining("paid") });
    await payOrder(order.id);
    expect(await requestRefund(order.accessToken, "Can't travel")).toEqual({ ok: true });
    expect(await requestRefund(order.accessToken, "Again")).toMatchObject({ ok: false, error: expect.stringContaining("already asked") });
    const request = await prisma.refundRequest.findFirstOrThrow({ where: { orderId: order.id } });
    expect(await decideRefundRequest(admin(), { requestId: request.id, decision: "decline" })).toMatchObject({ ok: false });
    expect(await decideRefundRequest(admin(), { requestId: request.id, decision: "approve", amount: "300" })).toEqual({ ok: true });
    expect(await prisma.refundRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: RefundRequestStatus.APPROVED, approvedMinor: BigInt(30000) });
    const refunds = await prisma.paymentRefund.findMany({ where: { payment: { orderId: order.id } } });
    expect(refunds.map((refund) => refund.amountMinor)).toEqual([BigInt(30000)]);
    expect(await decideRefundRequest(admin(), { requestId: request.id, decision: "approve" })).toMatchObject({ ok: false, error: expect.stringContaining("already decided") });
  });
});
