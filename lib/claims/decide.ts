import "server-only";

import { ExpenseClaimStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { noticeEach, noticeSubject } from "@/lib/notices";
import { formatMoney, parseMoneyToMinor } from "@/lib/payments/money";
import { offlineMethodLabel } from "@/lib/payments/paymentMethod";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import { checkPolicyApproval } from "./policies/claims";
import { approveSchema, decisionSchema, fail, ok, paidOnDate, payoutSchema, reverseSchema, type ClaimResult } from "./shared";

/**
 * Deciding and paying expense claims (docs/FINANCE.md): organisation owners
 * and admins only (the caller checks), each step under a row lock on the
 * claim, audited, emailed to the claimant and posted to chat.
 */

export type ClaimAdminContext = { userId: string; organisationId: string; };

const claimSelect = { id: true, organisationId: true, eventId: true, eventTitle: true, status: true, payeeName: true, payeeEmail: true, amountMinor: true, approvedMinor: true, currency: true, rsvpId: true, policyId: true, eligibilitySnapshot: true } satisfies Prisma.ExpenseClaimSelect;

/** After the decision commits: the claim's new status for organisation webhooks (ids and amounts only). */
function emitStatus<T>(result: ClaimResult<T>, claimId: string, status: ExpenseClaimStatus, previousStatus: ExpenseClaimStatus) {
  if (result.ok) emitWebhookEvent({ type: "expense_claim.status_changed", claimId, status, previousStatus });
  return result;
}

async function lockedClaim(tx: Prisma.TransactionClient, ctx: ClaimAdminContext, claimId: string) {
  // A policy claim's cap and budget are checked under the event lock, taken
  // before the claim's as when claims are filed.
  const policyClaim = await tx.expenseClaim.findFirst({ where: { id: claimId, organisationId: ctx.organisationId, policyId: { not: null } }, select: { eventId: true } });
  if (policyClaim?.eventId) await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${policyClaim.eventId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "ExpenseClaim" WHERE "id" = ${claimId} FOR UPDATE`;
  return tx.expenseClaim.findFirst({ where: { id: claimId, organisationId: ctx.organisationId }, select: claimSelect });
}

async function tellClaimant(tx: Prisma.TransactionClient, claim: { organisationId: string; payeeEmail: string; eventTitle: string; }, subject: string, lines: string[]) {
  await noticeEach(tx, [claim.payeeEmail], { organisationId: claim.organisationId, subject: noticeSubject(subject, claim.eventTitle), lines });
}

/** Approve a waiting claim, for the amount asked or less. */
export async function approveClaim(ctx: ClaimAdminContext, input: unknown): Promise<ClaimResult<undefined>> {
  const parsed = approveSchema.safeParse(input);
  if (!parsed.success) return fail("Check the approval.");
  const result = await prisma.$transaction(async (tx): Promise<ClaimResult<undefined>> => {
    const claim = await lockedClaim(tx, ctx, parsed.data.claimId);
    if (!claim) return fail("Claim not found.");
    if (claim.status !== ExpenseClaimStatus.SUBMITTED) return fail("Only claims waiting for a decision can be approved.");
    const approvedMinor = parsed.data.amount ? parseMoneyToMinor(parsed.data.amount, claim.currency) : claim.amountMinor;
    if (approvedMinor == null || approvedMinor <= BigInt(0) || approvedMinor > claim.amountMinor) return fail(`Approve between 0 and ${formatMoney(claim.amountMinor, claim.currency)}.`);
    // Under a policy: still eligible by the terms frozen at filing, within that cap and the policy's budget.
    const policy = claim.policyId ? await checkPolicyApproval(tx, { ...claim, policyId: claim.policyId }, approvedMinor) : null;
    if (policy && !policy.ok) return policy;
    await tx.expenseClaim.update({ where: { id: claim.id }, data: { status: ExpenseClaimStatus.APPROVED, approvedMinor, decisionNote: parsed.data.note, decidedByUserId: ctx.userId, decidedAt: new Date(), ...(policy?.ok ? { eligibilitySnapshot: policy.data.snapshot } : {}) } });
    const amount = formatMoney(approvedMinor, claim.currency);
    await recordAuditEvent({ action: "EXPENSE_CLAIM_APPROVED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "ExpenseClaim", targetId: claim.id, metadata: { approvedMinor: approvedMinor.toString(), partial: approvedMinor < claim.amountMinor }, client: tx });
    await notifyChat(tx, ctx.organisationId, "claim", `Claim approved: ${amount} for ${claim.payeeName} (${claim.eventTitle}).`);
    await tellClaimant(tx, claim, "Claim approved", [
      `Your expense claim for ${claim.eventTitle} was approved for ${amount}${approvedMinor < claim.amountMinor ? ` (you asked for ${formatMoney(claim.amountMinor, claim.currency)})` : ""}.`,
      ...(parsed.data.note ? [`Note from the organisers: ${parsed.data.note}`] : []),
      "We'll email you again when it has been paid.",
    ]);
    return ok(undefined);
  });
  return emitStatus(result, parsed.data.claimId, ExpenseClaimStatus.APPROVED, ExpenseClaimStatus.SUBMITTED);
}

/** Reject a waiting claim with a reason the claimant sees. */
export async function rejectClaim(ctx: ClaimAdminContext, input: unknown): Promise<ClaimResult<undefined>> {
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success || !parsed.data.note) return fail("Say why the claim is rejected.");
  const result = await prisma.$transaction(async (tx): Promise<ClaimResult<undefined>> => {
    const claim = await lockedClaim(tx, ctx, parsed.data.claimId);
    if (!claim) return fail("Claim not found.");
    if (claim.status !== ExpenseClaimStatus.SUBMITTED) return fail("Only claims waiting for a decision can be rejected.");
    await tx.expenseClaim.update({ where: { id: claim.id }, data: { status: ExpenseClaimStatus.REJECTED, decisionNote: parsed.data.note, decidedByUserId: ctx.userId, decidedAt: new Date() } });
    await recordAuditEvent({ action: "EXPENSE_CLAIM_REJECTED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "ExpenseClaim", targetId: claim.id, client: tx });
    await notifyChat(tx, ctx.organisationId, "claim", `Claim rejected: ${formatMoney(claim.amountMinor, claim.currency)} for ${claim.payeeName} (${claim.eventTitle}).`);
    await tellClaimant(tx, claim, "Claim not approved", [`Your expense claim of ${formatMoney(claim.amountMinor, claim.currency)} for ${claim.eventTitle} wasn't approved.`, `Reason: ${parsed.data.note}`]);
    return ok(undefined);
  });
  return emitStatus(result, parsed.data.claimId, ExpenseClaimStatus.REJECTED, ExpenseClaimStatus.SUBMITTED);
}

/** Record paying an approved claim (the approved amount, by hand): the claim becomes PAID. */
export async function recordClaimPayout(ctx: ClaimAdminContext, input: unknown): Promise<ClaimResult<undefined>> {
  const parsed = payoutSchema.safeParse(input);
  if (!parsed.success) return fail("Check the payout.");
  const paidAt = paidOnDate(parsed.data.paidOn);
  if (!paidAt) return fail("Choose the day it was paid, today or earlier.");
  const result = await prisma.$transaction(async (tx): Promise<ClaimResult<undefined>> => {
    const claim = await lockedClaim(tx, ctx, parsed.data.claimId);
    if (!claim) return fail("Claim not found.");
    if (claim.status !== ExpenseClaimStatus.APPROVED || claim.approvedMinor == null) return fail("Only approved claims can be paid.");
    const payout = await tx.claimPayout.create({
      data: {
        organisationId: ctx.organisationId, eventId: claim.eventId, claimId: claim.id, payeeName: claim.payeeName, amountMinor: claim.approvedMinor, currency: claim.currency,
        method: parsed.data.method, reference: parsed.data.reference || null, note: parsed.data.note, paidAt, recordedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await tx.expenseClaim.update({ where: { id: claim.id }, data: { status: ExpenseClaimStatus.PAID } });
    const amount = formatMoney(claim.approvedMinor, claim.currency);
    await recordAuditEvent({ action: "CLAIM_PAYOUT_RECORDED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "ClaimPayout", targetId: payout.id, metadata: { claimId: claim.id, amountMinor: claim.approvedMinor.toString(), method: parsed.data.method }, client: tx });
    await notifyChat(tx, ctx.organisationId, "payout", `Claim paid: ${amount} to ${claim.payeeName} (${claim.eventTitle}).`);
    await tellClaimant(tx, claim, "Claim paid", [`Your expense claim for ${claim.eventTitle} has been paid: ${amount} by ${offlineMethodLabel(parsed.data.method).toLowerCase()}${parsed.data.reference ? `, reference ${parsed.data.reference}` : ""}.`]);
    return ok(undefined);
  });
  return emitStatus(result, parsed.data.claimId, ExpenseClaimStatus.PAID, ExpenseClaimStatus.APPROVED);
}

/** Undo a claim payout with a reversal row; the claim goes back to approved. */
export async function reverseClaimPayout(ctx: ClaimAdminContext, input: unknown): Promise<ClaimResult<undefined>> {
  const parsed = reverseSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the reversal.");
  let reopened: string | null = null;
  const result = await prisma.$transaction(async (tx): Promise<ClaimResult<undefined>> => {
    const original = await tx.claimPayout.findFirst({ where: { id: parsed.data.payoutId, organisationId: ctx.organisationId, reversesId: null } });
    if (!original) return fail("Payout not found.");
    if (original.claimId) await tx.$queryRaw`SELECT "id" FROM "ExpenseClaim" WHERE "id" = ${original.claimId} FOR UPDATE`;
    if (await tx.claimPayout.count({ where: { reversesId: original.id } }) > 0) return fail("This payout is already reversed.");
    const reversal = await tx.claimPayout.create({
      data: {
        organisationId: original.organisationId, eventId: original.eventId, claimId: original.claimId, payeeName: original.payeeName, amountMinor: original.amountMinor,
        currency: original.currency, method: original.method, reference: original.reference, note: parsed.data.reason, paidAt: new Date(), reversesId: original.id, recordedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    if (original.claimId && (await tx.expenseClaim.updateMany({ where: { id: original.claimId, status: ExpenseClaimStatus.PAID }, data: { status: ExpenseClaimStatus.APPROVED } })).count === 1) reopened = original.claimId;
    await recordAuditEvent({ action: "CLAIM_PAYOUT_REVERSED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "ClaimPayout", targetId: reversal.id, metadata: { reverses: original.id }, client: tx });
    await notifyChat(tx, ctx.organisationId, "payout", `Claim payout reversed: ${formatMoney(original.amountMinor, original.currency)} to ${original.payeeName}.`);
    return ok(undefined);
  });
  return reopened ? emitStatus(result, reopened, ExpenseClaimStatus.APPROVED, ExpenseClaimStatus.PAID) : result;
}
