"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/app/actions/org";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { recordAuditEvent } from "@/lib/audit";
import { auth } from "@/lib/auth";
import { approveClaim, recordClaimPayout, rejectClaim, reverseClaimPayout } from "@/lib/claims/decide";
import { financeCurrency } from "@/lib/claims/shared";
import { submitStaffClaim, withdrawClaim } from "@/lib/claims/submit";
import { deletePolicy, savePolicy, setPolicyActive } from "@/lib/claims/policies/manage";
import { prisma } from "@/lib/db";
import { canViewEventDashboard } from "@/lib/eventAccess";
import { parseMoneyToMinor } from "@/lib/payments/money";
import { getMembership, isOrgAdmin } from "@/lib/permissions";
import { decideRefundRequest } from "@/lib/refundRequests";

/**
 * The event dashboard's Finance tab (docs/FINANCE.md). Anyone on the event's
 * dashboard (organisation members and co-organisers) files and withdraws
 * their own claims; owners and admins decide, pay, set the budget and decide
 * refund requests.
 */

const scopeSchema = z.object({ organisationSlug: z.string().trim().min(1).max(120), eventId: z.string().trim().min(1).max(128) }).strict();
type Scope = { userId: string; organisationId: string; eventId: string; path: string; };

async function resolveScope(scope: unknown, admin: boolean): Promise<Scope | { error: string; }> {
  const parsed = scopeSchema.safeParse(scope);
  if (!parsed.success) return { error: "Event not found." };
  const session = await auth();
  if (!session?.user?.id) return { error: "You must be signed in." };
  const userId = session.user.id;
  const organisation = await prisma.organisation.findUnique({ where: { slug: parsed.data.organisationSlug }, select: { id: true, slug: true } });
  const event = organisation ? await prisma.event.findFirst({ where: { id: parsed.data.eventId, organisationId: organisation.id }, select: { id: true } }) : null;
  if (!organisation || !event) return { error: "Event not found." };
  if (admin) {
    const membership = await getMembership(userId, organisation.id);
    if (!membership || !isOrgAdmin(membership.role)) return { error: "Only organisation owners and admins can do this." };
  } else if (!(await canViewEventDashboard({ userId, organisationId: organisation.id, eventId: event.id }))) {
    return { error: "You don't have access to this event." };
  }
  if (await isActionRateLimited("action", userId)) return { error: "Too many changes. Try again shortly." };
  return { userId, organisationId: organisation.id, eventId: event.id, path: `/dashboard/${organisation.slug}/event/${event.id}` };
}

async function done(scope: Scope, result: { ok: true; } | { ok: false; error: string; }): Promise<ActionResult> {
  if (!result.ok) return result;
  revalidatePath(scope.path);
  return { ok: true };
}

/** File a claim (multipart: the fields plus up to three `receipts` photos). */
export async function submitStaffClaimAction(formData: FormData): Promise<ActionResult> {
  const scope = await resolveScope({ organisationSlug: formData.get("organisationSlug"), eventId: formData.get("eventId") }, false);
  if ("error" in scope) return { ok: false, error: scope.error };
  const field = (name: string) => String(formData.get(name) ?? "");
  const files = formData.getAll("receipts").filter((value): value is File => value instanceof File);
  const result = await submitStaffClaim(scope, { category: field("category"), description: field("description"), amount: field("amount"), payeeName: field("payeeName"), payeeEmail: field("payeeEmail") }, files);
  return done(scope, result);
}

export async function withdrawStaffClaimAction(scopeInput: unknown, claimId: unknown): Promise<ActionResult> {
  const scope = await resolveScope(scopeInput, false);
  if ("error" in scope) return { ok: false, error: scope.error };
  return done(scope, await withdrawClaim(String(claimId ?? "").slice(0, 128), { userId: scope.userId, organisationId: scope.organisationId, eventId: scope.eventId }));
}

export async function approveClaimAction(scopeInput: unknown, input: unknown): Promise<ActionResult> {
  const scope = await resolveScope(scopeInput, true);
  if ("error" in scope) return { ok: false, error: scope.error };
  return done(scope, await approveClaim(scope, input));
}

export async function rejectClaimAction(scopeInput: unknown, input: unknown): Promise<ActionResult> {
  const scope = await resolveScope(scopeInput, true);
  if ("error" in scope) return { ok: false, error: scope.error };
  return done(scope, await rejectClaim(scope, input));
}

export async function recordClaimPayoutAction(scopeInput: unknown, input: unknown): Promise<ActionResult> {
  const scope = await resolveScope(scopeInput, true);
  if ("error" in scope) return { ok: false, error: scope.error };
  return done(scope, await recordClaimPayout(scope, input));
}

export async function reverseClaimPayoutAction(scopeInput: unknown, input: unknown): Promise<ActionResult> {
  const scope = await resolveScope(scopeInput, true);
  if ("error" in scope) return { ok: false, error: scope.error };
  return done(scope, await reverseClaimPayout(scope, input));
}

export async function decideRefundRequestAction(scopeInput: unknown, input: unknown): Promise<ActionResult> {
  const scope = await resolveScope(scopeInput, true);
  if ("error" in scope) return { ok: false, error: scope.error };
  return done(scope, await decideRefundRequest(scope, input));
}

/** Create or edit a reimbursement policy (docs/FINANCE.md "Reimbursement policies"). */
export async function saveReimbursementPolicyAction(scopeInput: unknown, input: unknown): Promise<ActionResult> {
  const scope = await resolveScope(scopeInput, true);
  if ("error" in scope) return { ok: false, error: scope.error };
  return done(scope, await savePolicy(scope, input));
}

/** Close a reimbursement policy to new claims, or open it again. */
export async function setReimbursementPolicyActiveAction(scopeInput: unknown, input: unknown): Promise<ActionResult> {
  const scope = await resolveScope(scopeInput, true);
  if ("error" in scope) return { ok: false, error: scope.error };
  return done(scope, await setPolicyActive(scope, input));
}

/** Delete a reimbursement policy nobody has claimed under. */
export async function deleteReimbursementPolicyAction(scopeInput: unknown, policyId: unknown): Promise<ActionResult> {
  const scope = await resolveScope(scopeInput, true);
  if ("error" in scope) return { ok: false, error: scope.error };
  return done(scope, await deletePolicy(scope, policyId));
}

const settingsSchema = z.object({ budget: z.string().trim().max(20).default(""), participantClaimsEnabled: z.boolean(), participantCap: z.string().trim().max(20).default(""), crewClaimsEnabled: z.boolean().default(false) }).strict();

/** The event budget, whether participants may claim expenses (up to a cap each), and whether crew may (docs/CREW.md). */
export async function saveFinanceSettingsAction(scopeInput: unknown, input: unknown): Promise<ActionResult> {
  const scope = await resolveScope(scopeInput, true);
  if ("error" in scope) return { ok: false, error: scope.error };
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the settings." };
  const event = await prisma.event.findUniqueOrThrow({ where: { id: scope.eventId }, select: { currency: true, organisationId: true } });
  const currency = await financeCurrency(prisma, event);
  const money = (value: string) => (value ? parseMoneyToMinor(value, currency) : BigInt(0));
  const budget = money(parsed.data.budget);
  const cap = money(parsed.data.participantCap);
  if (budget === null || cap === null) return { ok: false, error: `Enter amounts in ${currency}, for example 50000.` };
  await prisma.event.update({
    where: { id: scope.eventId },
    data: { budgetMinor: budget > BigInt(0) ? budget : null, participantClaimsEnabled: parsed.data.participantClaimsEnabled, participantClaimCapMinor: cap > BigInt(0) ? cap : null, crewClaimsEnabled: parsed.data.crewClaimsEnabled, ...(event.currency ? {} : budget > BigInt(0) || cap > BigInt(0) ? { currency } : {}) },
  });
  await recordAuditEvent({ action: "EVENT_FINANCE_UPDATED", actorUserId: scope.userId, organisationId: scope.organisationId, targetType: "Event", targetId: scope.eventId, metadata: { budget: budget > BigInt(0), participantClaims: parsed.data.participantClaimsEnabled, crewClaims: parsed.data.crewClaimsEnabled, cap: cap > BigInt(0) } });
  revalidatePath(scope.path);
  return { ok: true };
}
