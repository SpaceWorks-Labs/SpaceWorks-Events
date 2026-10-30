import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => identity.id ? { user: { id: identity.id } } : null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));

import { prisma } from "@/lib/db";
import { approveClaim, recordClaimPayout, reverseClaimPayout } from "@/lib/claims/decide";
import { submitParticipantClaim, withdrawClaim } from "@/lib/claims/submit";
import { queueReimbursementNotices } from "@/lib/claims/policies/notices";
import { loadTicketClaims } from "@/lib/claims/ticketView";
import { loadEventFinance, loadSpendingTotals } from "@/lib/finance";
import { formatMoney } from "@/lib/payments/money";
import { GET as exportFinance } from "@/app/api/exports/events/[eventId]/finance/route";
import { updateRsvpRegistration } from "@/app/actions/rsvp-admin";
import { email, owner, setUpPaidAttendance, tearDownPaidAttendance } from "./helpers/attendancePaid";
import { paid } from "./helpers/paidOrg";
import { holderRegistration } from "./helpers/holderRegistration";
import { holdNextTransaction } from "./helpers/transactionBarrier";
import { waitForLockWait } from "./helpers/lockWait";
import { fulfilled } from "./helpers/locks";

beforeAll(() => setUpPaidAttendance("Claim lock order"));
afterAll(() => tearDownPaidAttendance());
const input = { category: "TRAVEL", description: "Train fare", amount: "100" };
const admin = () => ({ userId: owner.id, organisationId: paid.organisationId });

async function reimbursement(eventId: string, notifyWhenAvailable = false) {
  return prisma.reimbursementPolicy.create({ data: {
    eventId, name: "Travel", eligibility: "CONFIRMED_PARTICIPANT", capPerPersonMinor: BigInt(100000), categories: ["TRAVEL"], notifyWhenAvailable,
  } });
}

describe.sequential("Event precedes claim, policy and registration locks", () => {
  it("serialises submission with the beat before Policy and RSVP foreign-key locks", async () => {
    const { event, seat } = await holderRegistration("notice-race");
    const policy = await reimbursement(event.id, true);
    const barrier = holdNextTransaction(true);
    const submitting = submitParticipantClaim({ ticketToken: seat.checkInToken, actorUserId: null }, { ...input, policyId: policy.id }, []);
    // Settle immediately so either PostgreSQL deadlock victim is observed safely.
    const submitted = Promise.allSettled([submitting]);
    let notices: Promise<PromiseSettledResult<Awaited<ReturnType<typeof queueReimbursementNotices>>>[]> | undefined;
    try {
      const pid = await barrier.entered;
      // Submission holds Event and RSVP. Old queueing holds Policy and waits
      // for RSVP; resuming submission then cycles on the Policy foreign key.
      notices = Promise.allSettled([queueReimbursementNotices()]);
      await waitForLockWait(pid);
    } finally {
      barrier.release();
      await submitted;
      await notices;
      barrier.restore();
    }
    expect(fulfilled((await submitted)[0])).toMatchObject({ ok: true });
    fulfilled((await notices!)[0]);
    expect(await prisma.expenseClaim.count({ where: { policyId: policy.id, rsvpId: seat.id } })).toBe(1);
    expect(await prisma.reimbursementNotice.count({ where: { policyId: policy.id, rsvpId: seat.id } })).toBe(1);
    expect(await prisma.outboxMessage.count({ where: { kind: "reimbursement-available", payload: { path: ["policyId"], equals: policy.id } } })).toBe(1);
    expect(await queueReimbursementNotices()).toMatchObject({ queued: 0 });
  });

  it.each([
    { operation: "record", underPolicy: false }, { operation: "record", underPolicy: true },
    { operation: "reverse", underPolicy: false }, { operation: "reverse", underPolicy: true },
  ] as const)("serialises a holder change with $operation (policy=$underPolicy)", async ({ operation, underPolicy }) => {
    const { event, seat } = await holderRegistration(`${operation}-${underPolicy}`);
    const policyId = underPolicy ? (await reimbursement(event.id)).id : "";
    const filed = await submitParticipantClaim({ ticketToken: seat.checkInToken, actorUserId: null }, { ...input, policyId }, []);
    if (!filed.ok) throw new Error(filed.error);
    const claimId = filed.data.claimId;
    expect(await approveClaim(admin(), { claimId })).toMatchObject({ ok: true });
    let payoutId = "";
    if (operation === "reverse") {
      expect(await recordClaimPayout(admin(), { claimId, method: "CASH" })).toMatchObject({ ok: true });
      payoutId = (await prisma.claimPayout.findFirstOrThrow({ where: { claimId } })).id;
    }
    const receipt = await prisma.expenseReceipt.create({ data: {
      claimId, storageKey: `organisations/${paid.organisationId}/claim-receipts/${randomUUID()}.webp`, byteSize: 100,
    } });
    const original = await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claimId } });
    identity.id = owner.id;
    const barrier = holdNextTransaction(true);
    const changing = Promise.allSettled([updateRsvpRegistration({
      organisationSlug: paid.orgSlug, eventId: event.id, rsvpId: seat.id, guestEmail: email(`new-${operation}-${underPolicy}`), answers: {},
    })]);
    let paying: Promise<PromiseSettledResult<Awaited<ReturnType<typeof recordClaimPayout>>>[]> | undefined;
    try {
      const pid = await barrier.entered;
      // Holder change holds Event and RSVP, before detaching Claim. Old
      // payout/reversal takes Claim then waits for Event key-share on insert.
      paying = Promise.allSettled([operation === "record"
        ? recordClaimPayout(admin(), { claimId, method: "CASH" })
        : reverseClaimPayout(admin(), { payoutId, reason: "Recorded by mistake" })]);
      await waitForLockWait(pid);
    } finally {
      barrier.release();
      await changing;
      await paying;
      barrier.restore();
      identity.id = "";
    }
    expect(fulfilled((await changing)[0])).toEqual({ ok: true });
    expect(fulfilled((await paying!)[0])).toMatchObject({ ok: true });
    expect(await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claimId } })).toMatchObject({
      rsvpId: null, payeeName: original.payeeName, payeeEmail: original.payeeEmail, amountMinor: original.amountMinor,
      approvedMinor: original.approvedMinor, eligibilitySnapshot: original.eligibilitySnapshot, policyId: original.policyId,
      status: operation === "record" ? "PAID" : "APPROVED",
    });
    expect(await prisma.expenseReceipt.count({ where: { id: receipt.id, claimId } })).toBe(1);
    const payouts = await prisma.claimPayout.findMany({ where: { claimId } });
    expect(payouts).toHaveLength(operation === "record" ? 1 : 2);
    expect(payouts.every((row) => row.eventId === event.id && row.amountMinor === original.approvedMinor && row.payeeName === original.payeeName)).toBe(true);
    if (operation === "reverse") expect(payouts.filter((row) => row.reversesId === payoutId)).toHaveLength(1);
    const current = await prisma.rSVP.findUniqueOrThrow({ where: { id: seat.id } });
    expect((await loadTicketClaims(current))?.claims).toEqual([]);
    const finance = await loadEventFinance(event.id, paid.organisationId);
    expect(finance?.claims).toContainEqual(expect.objectContaining({ id: claimId, payeeEmail: original.payeeEmail, receiptIds: [receipt.id] }));
    expect(finance?.summary.expensesPaid).toBe(formatMoney(BigInt(operation === "record" ? 10000 : 0), "INR"));
    expect(await loadSpendingTotals(event.id)).toMatchObject({
      expensesPaidMinor: operation === "record" ? 10000 : 0, approvedUnpaidMinor: operation === "record" ? 0 : 10000,
    });
    identity.id = owner.id;
    try {
      const response = await exportFinance(new Request(`http://localhost/api/exports/events/${event.id}/finance`), { params: Promise.resolve({ eventId: event.id }) });
      expect(response.status).toBe(200);
      const csv = await response.text();
      expect(csv).toContain(`Expense payout,${original.payeeName},Train fare,'-100.00,INR,Cash`);
      if (operation === "reverse") expect(csv).toContain(`Expense payout reversed,${original.payeeName},Train fare,100.00,INR,Cash`);
    } finally { identity.id = ""; }
  });

  it("rechecks withdrawal scope after a holder change detaches the claim", async () => {
    const { event, seat } = await holderRegistration("withdraw-race");
    const filed = await submitParticipantClaim({ ticketToken: seat.checkInToken, actorUserId: null }, input, []);
    if (!filed.ok) throw new Error(filed.error);
    identity.id = owner.id;
    const barrier = holdNextTransaction(true);
    const changing = Promise.allSettled([updateRsvpRegistration({
      organisationSlug: paid.orgSlug, eventId: event.id, rsvpId: seat.id, guestEmail: email("withdraw-new"), answers: {},
    })]);
    let withdrawing: Promise<Awaited<ReturnType<typeof withdrawClaim>>> | undefined;
    try {
      const pid = await barrier.entered;
      withdrawing = withdrawClaim(filed.data.claimId, { rsvpId: seat.id });
      await waitForLockWait(pid);
    } finally {
      barrier.release();
      await changing;
      await withdrawing;
      barrier.restore();
      identity.id = "";
    }
    expect(fulfilled((await changing)[0])).toEqual({ ok: true });
    expect(await withdrawing).toEqual({ ok: false, error: "Claim not found." });
    expect(await prisma.expenseClaim.findUniqueOrThrow({ where: { id: filed.data.claimId } })).toMatchObject({ rsvpId: null, status: "SUBMITTED" });
  });
});
