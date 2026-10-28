import { EventStatus, RsvpStatus, SubmissionStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));

import { prisma } from "@/lib/db";
import { disqualifySubmission, reinstateSubmission, submitSubmission, type EntrantAuth } from "@/lib/core/judging";
import { REFUNDED_FEE_REFUSAL } from "@/lib/core/judging/disqualification";
import { settleOrderByHand } from "@/lib/payments/operations";
import { paid, payOrder, setUpPaidOrg, tearDownPaidOrg } from "./helpers/paidOrg";

/*
 * The submission receipt is opt-in per event (lib/hackathonEmails.ts) on the
 * entry-fee path too: a project submitted once its fee is paid
 * (confirmEntryFeeTx) gets `submission-received` only when receipts are on.
 * Payment emails (paid, refunded) are never gated.
 */

let counter = 0;
const HOUR = 3_600_000;

async function hackathon(emailSubmissionReceipts: boolean) {
  counter += 1;
  return prisma.event.create({ data: {
    organisationId: paid.organisationId, title: `Receipts ${counter}`, slug: `receipts-${paid.suffix}-${counter}`, currency: "INR",
    startDateTime: new Date(Date.now() - HOUR), endDateTime: new Date(Date.now() + 48 * HOUR), timezone: "UTC", status: EventStatus.PUBLISHED,
    submissionsEnabled: true, submissionsOpenAt: new Date(Date.now() - HOUR), submissionsCloseAt: new Date(Date.now() + 24 * HOUR),
    submissionFeeMinor: BigInt(15000), emailSubmissionReceipts, page: { create: { isPublished: true } },
  } });
}

async function entrant(eventId: string, label: string): Promise<EntrantAuth & { kind: "solo-owner" }> {
  const user = await prisma.user.create({ data: { email: `${label}-${paid.suffix}@example.test`, name: `Entrant ${label}` } });
  const rsvp = await prisma.rSVP.create({ data: { eventId, userId: user.id, attendeeKey: `user:${user.id}`, status: RsvpStatus.CONFIRMED } });
  return { kind: "solo-owner", eventId, rsvpId: rsvp.id, userId: user.id };
}

/** Submit with the fee owed: the project waits as a draft behind a pending order. */
async function feeOwed(emailSubmissionReceipts: boolean, label: string) {
  const event = await hackathon(emailSubmissionReceipts);
  const auth = await entrant(event.id, label);
  expect(await submitSubmission(auth, { title: "Rocket telemetry" })).toMatchObject({ ok: true, data: { status: SubmissionStatus.DRAFT, receiptQueued: false } });
  const submission = await prisma.submission.findFirstOrThrow({ where: { eventId: event.id } });
  const order = await prisma.order.findFirstOrThrow({ where: { submissionId: submission.id } });
  return { event, submission, order };
}

const receipts = (submissionId: string) => prisma.outboxMessage.count({ where: { kind: "submission-received", payload: { path: ["submissionId"], equals: submissionId } } });
const notices = async (orderId: string, notice: string) => {
  const payments = await prisma.payment.findMany({ where: { orderId }, select: { id: true } });
  return prisma.outboxMessage.count({ where: { kind: "payment-notice", payload: { path: ["notice"], equals: notice }, OR: payments.map((payment) => ({ payload: { path: ["paymentId"], equals: payment.id } })) } });
};

let organiserId = "";

beforeAll(async () => {
  await setUpPaidOrg("Hackathon receipts");
  organiserId = (await prisma.user.create({ data: { email: `organiser-${paid.suffix}@example.test` } })).id;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `${paid.suffix}@example.test` } } });
  await tearDownPaidOrg();
});

describe.sequential("hackathon receipts on the entry-fee path", () => {
  it("submits a paid project without a receipt when receipts are off, but still sends the paid and refunded emails", async () => {
    const { event, submission, order } = await feeOwed(false, "off");
    expect((await payOrder(order.id)).outcome).toBe("confirmed");
    expect(await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } })).toMatchObject({ status: SubmissionStatus.SUBMITTED });
    expect(await receipts(submission.id)).toBe(0);
    expect(await notices(order.id, "paid")).toBe(1);

    const organiser = { userId: organiserId, organisationId: paid.organisationId, orgSlug: paid.orgSlug, eventId: event.id, eventSlug: event.slug };
    expect(await disqualifySubmission(organiser, { submissionId: submission.id, reason: "Plagiarised" })).toMatchObject({ ok: true });
    expect(await notices(order.id, "refunded")).toBe(1);
    // Its fee came back, so reinstating would leave it submitted unpaid.
    expect(await reinstateSubmission(organiser, submission.id)).toMatchObject({ ok: false, error: REFUNDED_FEE_REFUSAL });
    expect(await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } })).toMatchObject({ status: SubmissionStatus.DISQUALIFIED });
  });

  it("queues exactly one receipt when receipts are on and the provider confirms the fee", async () => {
    const { submission, order } = await feeOwed(true, "on");
    expect((await payOrder(order.id)).outcome).toBe("confirmed");
    expect(await receipts(submission.id)).toBe(1);
    const receipt = await prisma.outboxMessage.findFirstOrThrow({ where: { kind: "submission-received", payload: { path: ["submissionId"], equals: submission.id } } });
    expect((receipt.payload as { to: string }).to).toBe(order.buyerEmail);
    expect(await notices(order.id, "paid")).toBe(1);
  });

  it("follows the switch when the fee is settled by hand, and reads it at confirmation time", async () => {
    const offline = await feeOwed(false, "offline");
    // Turned on after the checkout opened: the value at confirmation counts.
    await prisma.event.update({ where: { id: offline.event.id }, data: { emailSubmissionReceipts: true } });
    expect(await settleOrderByHand({ orderId: offline.order.id, organisationId: paid.organisationId, actorUserId: organiserId, mode: "offline", method: "CASH" })).toBe("confirmed");
    expect(await receipts(offline.submission.id)).toBe(1);
    expect(await notices(offline.order.id, "paid")).toBe(1);

    const waived = await feeOwed(false, "waived");
    expect(await settleOrderByHand({ orderId: waived.order.id, organisationId: paid.organisationId, actorUserId: organiserId, mode: "waive" })).toBe("confirmed");
    expect(await prisma.submission.findUniqueOrThrow({ where: { id: waived.submission.id } })).toMatchObject({ status: SubmissionStatus.SUBMITTED });
    expect(await receipts(waived.submission.id)).toBe(0);
    // A waived fee is never refunded: the project can be disqualified and reinstated.
    const organiser = { userId: organiserId, organisationId: paid.organisationId, orgSlug: paid.orgSlug, eventId: waived.event.id, eventSlug: waived.event.slug };
    expect(await disqualifySubmission(organiser, { submissionId: waived.submission.id, reason: "Checking" })).toMatchObject({ ok: true });
    expect(await reinstateSubmission(organiser, waived.submission.id)).toMatchObject({ ok: true });
  });
});
