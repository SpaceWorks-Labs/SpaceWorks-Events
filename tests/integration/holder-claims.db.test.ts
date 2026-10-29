import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => identity.id ? { user: { id: identity.id } } : null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.stubEnv("S3_BUCKET", "");

import { prisma } from "@/lib/db";
import { submitParticipantClaim } from "@/lib/claims/submit";
import { approveClaim } from "@/lib/claims/decide";
import { loadTicketClaims } from "@/lib/claims/ticketView";
import { transferTicket } from "@/lib/payments/transfers";
import { newTicketToken } from "@/lib/rsvpHolder";
import { updateRsvpRegistration } from "@/app/actions/rsvp-admin";
import { email, owner, setUpPaidAttendance, tearDownPaidAttendance } from "./helpers/attendancePaid";
import { paid } from "./helpers/paidOrg";
import { holderRegistration } from "./helpers/holderRegistration";
import { holdNextTransaction } from "./helpers/transactionBarrier";
import { waitForLockWait, whileLocked } from "./helpers/lockWait";

beforeAll(() => setUpPaidAttendance("Holder claims"));
afterAll(() => tearDownPaidAttendance());
const input = { category: "TRAVEL", description: "Train fare", amount: "100" };

async function reimbursement(eventId: string) {
  return prisma.reimbursementPolicy.create({ data: { eventId, name: "Travel", eligibility: "CONFIRMED_PARTICIPANT", capPerPersonMinor: BigInt(100000), categories: ["TRAVEL"] } });
}

describe.sequential("claims stay with the original holder", () => {
  it.each(["buyer", "organiser"])("keeps closed claims private after a %s holder change, preserving the financial records", async (editor) => {
    const { event, order, seat } = await holderRegistration(`closed-${editor}`);
    const policy = await reimbursement(event.id);
    const claims = await Promise.all((["REJECTED", "WITHDRAWN"] as const).map((status) => prisma.expenseClaim.create({ data: {
      organisationId: paid.organisationId, eventId: event.id, eventTitle: event.title, kind: "PARTICIPANT", status,
      rsvpId: seat.id, payeeEmail: seat.guestEmail!, payeeName: "Original Holder", amountMinor: BigInt(10000), currency: "INR",
      category: "TRAVEL", description: "Private expense", decisionNote: "Private explanation", ...(status === "REJECTED" ? { policyId: policy.id, eligibilitySnapshot: {} } : {}),
    } })));
    expect((await loadTicketClaims(seat))?.claims).toHaveLength(2);
    identity.id = owner.id;
    try {
      if (editor === "buyer") await transferTicket({ orderToken: order.accessToken, rsvpId: seat.id, name: "Replacement", email: email(`closed-new-${editor}`) });
      else expect(await updateRsvpRegistration({ organisationSlug: paid.orgSlug, eventId: event.id, rsvpId: seat.id, name: "Replacement", guestEmail: email(`closed-new-${editor}`), answers: {} })).toEqual({ ok: true });
    } finally { identity.id = ""; }
    const current = await prisma.rSVP.findUniqueOrThrow({ where: { id: seat.id } });
    expect((await loadTicketClaims(current))?.claims).toEqual([]);
    for (const claim of claims) {
      const kept = await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } });
      expect(kept).toMatchObject({ rsvpId: null, payeeEmail: seat.guestEmail, decisionNote: "Private explanation", status: claim.status, policyId: claim.policyId, amountMinor: claim.amountMinor });
    }
  });

  it("keeps an organiser's former-holder open claims and receipts private and cannot reuse replacement eligibility", async () => {
    const { event, seat } = await holderRegistration("open-records");
    const policy = await reimbursement(event.id);
    const result = await submitParticipantClaim({ ticketToken: seat.checkInToken, actorUserId: null }, { ...input, policyId: policy.id }, []);
    expect(result.ok).toBe(true);
    const claim = await prisma.expenseClaim.findFirstOrThrow({ where: { rsvpId: seat.id } });
    const receipt = await prisma.expenseReceipt.create({ data: { claimId: claim.id, storageKey: `organisations/${paid.organisationId}/claim-receipts/12345678-1234-4123-8123-123456789abc.webp`, byteSize: 100 } });
    identity.id = owner.id;
    try {
      expect(await updateRsvpRegistration({ organisationSlug: paid.orgSlug, eventId: event.id, rsvpId: seat.id, guestEmail: email("open-new"), answers: {} })).toEqual({ ok: true });
    } finally { identity.id = ""; }
    const current = await prisma.rSVP.findUniqueOrThrow({ where: { id: seat.id } });
    expect((await loadTicketClaims(current))?.claims).toEqual([]);
    expect(await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ rsvpId: null, payeeEmail: seat.guestEmail, status: "SUBMITTED", eligibilitySnapshot: claim.eligibilitySnapshot });
    expect(await prisma.expenseReceipt.findUnique({ where: { id: receipt.id } })).not.toBeNull();
    expect((await approveClaim({ userId: owner.id, organisationId: paid.organisationId }, { claimId: claim.id })).ok).toBe(false);
  });

  it.each([false, true])("refuses a retired ticket after waiting behind a real transfer (policy=%s)", async (underPolicy) => {
    const { event, order, seat } = await holderRegistration(`claim-race-${underPolicy}`);
    const policyId = underPolicy ? (await reimbursement(event.id)).id : "";
    const receipt = new File([new Uint8Array(await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer())], "receipt.png", { type: "image/png" });
    const barrier = holdNextTransaction();
    const moving = transferTicket({ orderToken: order.accessToken, rsvpId: seat.id, name: "Replacement", email: email(`race-new-${underPolicy}`) });
    let claiming: ReturnType<typeof submitParticipantClaim> | undefined;
    try {
      const pid = await barrier.entered;
      claiming = submitParticipantClaim({ ticketToken: seat.checkInToken, actorUserId: null }, { ...input, policyId }, [receipt]);
      await waitForLockWait(pid);
    } finally { barrier.release(); await moving; barrier.restore(); }
    expect(await claiming).toEqual({ ok: false, error: "Registration not found." });
    expect(await prisma.expenseClaim.count({ where: { eventId: event.id } })).toBe(0);
    const current = await prisma.rSVP.findUniqueOrThrow({ where: { id: seat.id } });
    expect(await submitParticipantClaim({ ticketToken: current.checkInToken, actorUserId: null }, { ...input, policyId }, [])).toMatchObject({ ok: true });
    const claim = await prisma.expenseClaim.findFirstOrThrow({ where: { eventId: event.id } });
    expect(claim).toMatchObject({ payeeName: "Replacement", payeeEmail: current.guestEmail });
  });

  it.each(["account", "status", "crew"])("rechecks %s after the Event lock even without token rotation", async (change) => {
    const { event, seat } = await holderRegistration(`recheck-${change}`);
    const result = await whileLocked(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`;
      await tx.rSVP.update({ where: { id: seat.id }, data: change === "account" ? { userId: owner.id } : change === "status" ? { status: "REJECTED" } : { isCrew: true, orderId: null, ticketTypeId: null } });
    }, () => submitParticipantClaim({ ticketToken: seat.checkInToken, actorUserId: null }, input, []));
    expect(result.ok).toBe(false);
    expect(await prisma.expenseClaim.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("derives current crew classification and payee name from the locked registration", async () => {
    const { event, seat } = await holderRegistration("current-payee");
    await prisma.event.update({ where: { id: event.id }, data: { crewClaimsEnabled: true } });
    const result = await whileLocked(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`;
      await tx.rSVP.update({ where: { id: seat.id }, data: { isCrew: true, orderId: null, ticketTypeId: null, guestName: "Current name" } });
    }, () => submitParticipantClaim({ ticketToken: seat.checkInToken, actorUserId: null }, input, []));
    expect(result.ok).toBe(true);
    expect(await prisma.expenseClaim.findFirstOrThrow({ where: { eventId: event.id } })).toMatchObject({ kind: "CREW", payeeName: "Current name" });
  });

  it("rejects a retired token while Event is held before the holder write", async () => {
    const { event, seat } = await holderRegistration("late-write");
    const result = await whileLocked((tx) => tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`,
      () => submitParticipantClaim({ ticketToken: seat.checkInToken, actorUserId: null }, input, []),
      { beforeRelease: (tx) => tx.rSVP.update({ where: { id: seat.id }, data: { checkInToken: newTicketToken() } }) });
    expect(result.ok).toBe(false);
  });
});
