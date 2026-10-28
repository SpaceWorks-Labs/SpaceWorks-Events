import "server-only";

import { ExpenseClaimKind, ExpenseClaimStatus, RsvpStatus, type ExpenseCategory, type Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { noticeEach, noticeSubject, organiserEmails } from "@/lib/notices";
import { formatMoney, parseMoneyToMinor } from "@/lib/payments/money";
import { deleteReceipts } from "@/lib/storage/private";
import { CATEGORY_LABELS, claimFieldsSchema, fail, financeCurrency, ok, staffClaimSchema, storeReceipts, type ClaimResult } from "./shared";

/** Filing and withdrawing expense claims (docs/FINANCE.md). */

/** A staff member allowed on the event's dashboard (checked by the caller, with staff MFA). */
export type StaffClaimContext = { userId: string; organisationId: string; eventId: string; };

type NewClaim = {
  organisationId: string;
  event: { id: string; title: string; };
  kind: ExpenseClaimKind;
  submittedByUserId: string | null;
  rsvpId: string | null;
  payee: { name: string; email: string; };
  category: ExpenseCategory;
  description: string;
  amountMinor: bigint;
  currency: string;
};

/** Store the claim and its receipts, tell the owners and admins, and audit it. */
async function createClaim(tx: Prisma.TransactionClient, claim: NewClaim, receipts: Array<{ key: string; byteSize: number; }>) {
  const created = await tx.expenseClaim.create({
    data: {
      organisationId: claim.organisationId, eventId: claim.event.id, eventTitle: claim.event.title.slice(0, 200), kind: claim.kind,
      submittedByUserId: claim.submittedByUserId, rsvpId: claim.rsvpId, payeeName: claim.payee.name.slice(0, 120), payeeEmail: claim.payee.email,
      category: claim.category, description: claim.description, amountMinor: claim.amountMinor, currency: claim.currency,
      receipts: { create: receipts.map((receipt) => ({ storageKey: receipt.key, byteSize: receipt.byteSize })) },
    },
    select: { id: true },
  });
  const amount = formatMoney(claim.amountMinor, claim.currency);
  await recordAuditEvent({ action: "EXPENSE_CLAIM_SUBMITTED", actorUserId: claim.submittedByUserId, organisationId: claim.organisationId, targetType: "ExpenseClaim", targetId: created.id, metadata: { eventId: claim.event.id, kind: claim.kind, amountMinor: claim.amountMinor.toString(), receipts: receipts.length }, client: tx });
  await notifyChat(tx, claim.organisationId, "claim", `${claim.payee.name} claimed ${amount} (${CATEGORY_LABELS[claim.category]}) for ${claim.event.title}.`);
  await noticeEach(tx, await organiserEmails(tx, claim.organisationId), {
    organisationId: claim.organisationId,
    subject: noticeSubject("Expense claim", claim.event.title),
    lines: [`${claim.payee.name} claimed ${amount} (${CATEGORY_LABELS[claim.category]}) for ${claim.event.title}.`, "Approve or reject it from the event's Finance tab."],
  });
  return created.id;
}

function amountIn(currency: string, value: string) {
  const amountMinor = parseMoneyToMinor(value, currency);
  return amountMinor != null && amountMinor > BigInt(0) ? amountMinor : null;
}

/** An organisation member or co-organiser claims money spent on the event, for themselves or someone else. */
export async function submitStaffClaim(ctx: StaffClaimContext, input: unknown, files: File[]): Promise<ClaimResult<{ claimId: string; }>> {
  const parsed = staffClaimSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the claim.");
  if (parsed.data.payeeEmail && !z.string().email().safeParse(parsed.data.payeeEmail).success) return fail("Enter a valid email address for who is being paid back.");
  const [user, event] = await Promise.all([
    prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true, email: true } }),
    prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: { id: true, title: true, currency: true, organisationId: true } }),
  ]);
  if (!event || !user?.email) return fail("Event not found.");
  const currency = await financeCurrency(prisma, event);
  const amountMinor = amountIn(currency, parsed.data.amount);
  if (!amountMinor) return fail(`Enter the amount in ${currency}, for example 1200 or 1200.50.`);
  const payee = { name: parsed.data.payeeName || user.name?.trim() || user.email, email: parsed.data.payeeEmail.toLowerCase() || user.email };
  const stored = await storeReceipts(ctx.organisationId, files);
  if ("error" in stored) return fail(stored.error);
  try {
    const claimId = await prisma.$transaction((tx) => createClaim(tx, {
      organisationId: ctx.organisationId, event, kind: ExpenseClaimKind.STAFF, submittedByUserId: ctx.userId, rsvpId: null, payee,
      category: parsed.data.category, description: parsed.data.description, amountMinor, currency,
    }, stored.keys));
    return ok({ claimId });
  } catch (error) {
    await deleteReceipts(stored.keys.map((receipt) => receipt.key));
    throw error;
  }
}

/** What a participant has claimed so far: asked for while open, approved once decided. */
async function claimedSoFar(tx: Prisma.TransactionClient, rsvpId: string) {
  const claims = await tx.expenseClaim.findMany({
    where: { rsvpId, status: { in: [ExpenseClaimStatus.SUBMITTED, ExpenseClaimStatus.APPROVED, ExpenseClaimStatus.PAID] } },
    select: { status: true, amountMinor: true, approvedMinor: true },
  });
  return claims.reduce((sum, claim) => sum + (claim.status === ExpenseClaimStatus.SUBMITTED ? claim.amountMinor : claim.approvedMinor ?? BigInt(0)), BigInt(0));
}

/**
 * A confirmed participant claims expenses from their ticket page (travel
 * grants), when the event allows it, up to its cap per person. The ticket
 * token proves the registration; an account-owned one also needs that
 * account signed in. A crew ticket (docs/CREW.md) files a CREW claim instead,
 * when the event takes crew claims, with no cap.
 */
export async function submitParticipantClaim(holder: { ticketToken: string; actorUserId: string | null; }, input: unknown, files: File[]): Promise<ClaimResult<{ claimId: string; }>> {
  const parsed = claimFieldsSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the claim.");
  const rsvp = await prisma.rSVP.findUnique({
    where: { checkInToken: holder.ticketToken },
    select: { id: true, status: true, isCrew: true, userId: true, guestName: true, guestEmail: true, user: { select: { name: true, email: true } }, event: { select: { id: true, title: true, currency: true, organisationId: true, participantClaimsEnabled: true, crewClaimsEnabled: true } } },
  });
  if (!rsvp?.event) return fail("Registration not found.");
  if (rsvp.userId && rsvp.userId !== holder.actorUserId) return fail("Sign in with the account this ticket belongs to.");
  if (rsvp.status !== RsvpStatus.CONFIRMED) return fail("Only confirmed participants can claim expenses.");
  const crew = rsvp.isCrew;
  const closed = crew ? "This event doesn't take expense claims from crew." : "This event doesn't take expense claims from participants.";
  if (!(crew ? rsvp.event.crewClaimsEnabled : rsvp.event.participantClaimsEnabled)) return fail(closed);
  const event = rsvp.event;
  const email = rsvp.user?.email?.trim() || rsvp.guestEmail;
  if (!email) return fail("Your registration needs an email address to claim expenses.");
  const currency = await financeCurrency(prisma, event);
  const amountMinor = amountIn(currency, parsed.data.amount);
  if (!amountMinor) return fail(`Enter the amount in ${currency}, for example 1200 or 1200.50.`);
  const stored = await storeReceipts(event.organisationId, files);
  if ("error" in stored) return fail(stored.error);
  try {
    const result = await prisma.$transaction(async (tx): Promise<ClaimResult<{ claimId: string; }>> => {
      // The cap is checked under the event lock so two claims can't both slip under it.
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`;
      const current = await tx.event.findUnique({ where: { id: event.id }, select: { participantClaimsEnabled: true, participantClaimCapMinor: true, crewClaimsEnabled: true } });
      if (!current || !(crew ? current.crewClaimsEnabled : current.participantClaimsEnabled)) return fail(closed);
      // Crew claims have no cap: owners and admins decide each one.
      const cap = crew ? null : current.participantClaimCapMinor;
      if (cap != null) {
        const left = cap - await claimedSoFar(tx, rsvp.id);
        if (amountMinor > left) return fail(left > BigInt(0) ? `You can claim up to ${formatMoney(cap, currency)} in all; ${formatMoney(left, currency)} is left.` : `You've already claimed the most this event pays back (${formatMoney(cap, currency)}).`);
      }
      const name = rsvp.user?.name?.trim() || rsvp.guestName?.trim() || email;
      return ok({ claimId: await createClaim(tx, {
        organisationId: event.organisationId, event, kind: crew ? ExpenseClaimKind.CREW : ExpenseClaimKind.PARTICIPANT, submittedByUserId: holder.actorUserId, rsvpId: rsvp.id,
        payee: { name, email }, category: parsed.data.category, description: parsed.data.description, amountMinor, currency,
      }, stored.keys) });
    });
    if (!result.ok) await deleteReceipts(stored.keys.map((receipt) => receipt.key));
    return result;
  } catch (error) {
    await deleteReceipts(stored.keys.map((receipt) => receipt.key));
    throw error;
  }
}

/** The claimant takes back a claim nobody has decided yet. */
export async function withdrawClaim(claimId: string, claimant: { userId: string | null; rsvpId?: string | null; }): Promise<ClaimResult<undefined>> {
  if (!claimant.userId && !claimant.rsvpId) return fail("Claim not found.");
  return prisma.$transaction(async (tx) => {
    const claim = await tx.expenseClaim.findFirst({
      where: { id: claimId, OR: [...(claimant.userId ? [{ submittedByUserId: claimant.userId }] : []), ...(claimant.rsvpId ? [{ rsvpId: claimant.rsvpId }] : [])] },
      select: { id: true, organisationId: true },
    });
    if (!claim) return fail("Claim not found.");
    const updated = await tx.expenseClaim.updateMany({ where: { id: claim.id, status: ExpenseClaimStatus.SUBMITTED }, data: { status: ExpenseClaimStatus.WITHDRAWN } });
    if (updated.count !== 1) return fail("Only claims waiting for a decision can be withdrawn.");
    await recordAuditEvent({ action: "EXPENSE_CLAIM_WITHDRAWN", actorUserId: claimant.userId, organisationId: claim.organisationId, targetType: "ExpenseClaim", targetId: claim.id, client: tx });
    return ok(undefined);
  });
}
