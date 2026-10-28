import "server-only";

import { ExpenseClaimStatus, type ExpenseCategory, type Prisma } from "@prisma/client";
import { formatMoney } from "@/lib/payments/money";
import { fail, ok, type ClaimResult } from "../shared";
import { eligibleRegistrationIds, evaluateEligibility, loadClaimant, type Claimant, type EligibilityTerms } from "./eligibility";
import { approvalProblem, remaining, sumCounted, sumDecided, windowState } from "./math";
import { eligibilityTerms, freezeTerms, readSnapshot, recordCheck, snapshotJson, type EligibilitySnapshot } from "./snapshot";

/**
 * Claims under a reimbursement policy (docs/FINANCE.md "Reimbursement
 * policies"). Both checks run inside the caller's transaction after it has
 * locked the event row, so two claims or two approvals can't both slip under
 * a cap or a budget.
 */

const COUNTED = [ExpenseClaimStatus.SUBMITTED, ExpenseClaimStatus.APPROVED, ExpenseClaimStatus.PAID];
const DECIDED = [ExpenseClaimStatus.APPROVED, ExpenseClaimStatus.PAID];
const usageSelect = { status: true, amountMinor: true, approvedMinor: true } as const;

/** What one person has used of a policy, and what the whole policy has (waiting plus decided). */
export async function policyUsage(client: Prisma.TransactionClient, policyId: string, rsvpId: string | null) {
  const [mine, all] = await Promise.all([
    rsvpId ? client.expenseClaim.findMany({ where: { policyId, rsvpId, status: { in: COUNTED } }, select: usageSelect }) : [],
    client.expenseClaim.findMany({ where: { policyId, status: { in: COUNTED } }, select: usageSelect }),
  ]);
  return { personUsed: sumCounted(mine), budgetUsed: sumCounted(all) };
}

export type PolicyClaimCheck = { policyId: string; policyName: string; snapshot: Prisma.InputJsonValue };

/** Whether this registration may file this claim under the policy now; the frozen snapshot when it may. */
export async function checkPolicyClaim(tx: Prisma.TransactionClient, params: { claimant: Claimant; policyId: string; category: ExpenseCategory; amountMinor: bigint; currency: string }, now = new Date()): Promise<ClaimResult<PolicyClaimCheck>> {
  const { claimant, currency } = params;
  const policy = await tx.reimbursementPolicy.findFirst({ where: { id: params.policyId, eventId: claimant.eventId } });
  if (!policy || !policy.active) return fail("That reimbursement isn't open for claims.");
  const window = windowState(policy, now);
  if (window !== "open") return fail(window === "upcoming" ? `Claims under ${policy.name} aren't open yet.` : `Claims under ${policy.name} have closed.`);
  if (!policy.categories.includes(params.category)) return fail(`${policy.name} doesn't cover that category.`);
  const evaluation = await evaluateEligibility(tx, claimant, policy);
  if (!evaluation.eligible) return fail(`${policy.name} isn't available to you. ${evaluation.reason ?? ""}`.trim());
  const usage = await policyUsage(tx, policy.id, claimant.rsvpId);
  const left = remaining({ capPerPerson: policy.capPerPersonMinor, personUsed: usage.personUsed, budget: policy.budgetMinor, budgetUsed: usage.budgetUsed });
  if (params.amountMinor > left.person) {
    return fail(left.person > BigInt(0) ? `You can claim up to ${formatMoney(policy.capPerPersonMinor, currency)} under ${policy.name}; ${formatMoney(left.person, currency)} is left.` : `You've already claimed the most ${policy.name} pays back (${formatMoney(policy.capPerPersonMinor, currency)}).`);
  }
  if (left.budget != null && params.amountMinor > left.budget) {
    return fail(left.budget > BigInt(0) ? `${policy.name} has ${formatMoney(left.budget, currency)} left to pay out.` : `${policy.name} has paid out its whole budget.`);
  }
  const snapshot: EligibilitySnapshot = { version: 1, terms: freezeTerms(policy), submitted: recordCheck(evaluation, now) };
  return ok({ policyId: policy.id, policyName: policy.name, snapshot: snapshotJson(snapshot) });
}

/** The highest of the caps the counted claims were filed under and the policy's current cap. */
function personCap(snapshots: Array<EligibilitySnapshot | null>, currentCap: bigint | null) {
  return snapshots.reduce((cap, row) => (row && BigInt(row.terms.capPerPersonMinor) > cap ? BigInt(row.terms.capPerPersonMinor) : cap), currentCap ?? BigInt(0));
}

type ClaimForApproval = { id: string; eventId: string | null; rsvpId: string | null; policyId: string; currency: string; eligibilitySnapshot: Prisma.JsonValue | null };

/**
 * Approving a policy claim: the person must still qualify under the terms
 * frozen when they filed (eligibility is checked at decision time), and
 * everything decided for them under the policy, this approval included, must
 * stay within the highest of the caps those claims were filed under and the
 * policy's current cap, so the order of approvals never matters. The policy
 * must stay within its current budget. Returns the snapshot with the
 * approval check added.
 */
export async function checkPolicyApproval(tx: Prisma.TransactionClient, claim: ClaimForApproval, approvedMinor: bigint, now = new Date()): Promise<ClaimResult<{ snapshot: Prisma.InputJsonValue }>> {
  const snapshot = readSnapshot(claim.eligibilitySnapshot);
  if (!snapshot) return fail("This claim's policy terms are missing. Reject it and ask for a new claim.");
  const claimant = claim.rsvpId && claim.eventId ? await loadClaimant(tx, claim.rsvpId, claim.eventId) : null;
  if (!claimant) return fail("The registration behind this claim no longer exists. Reject the claim instead.");
  const evaluation = await evaluateEligibility(tx, claimant, eligibilityTerms(snapshot.terms));
  if (!evaluation.eligible) return fail(`No longer eligible under ${snapshot.terms.name}: ${evaluation.reason ?? "the rules aren't met."} Reject the claim instead.`);
  const [mine, all, policy] = await Promise.all([
    tx.expenseClaim.findMany({ where: { policyId: claim.policyId, rsvpId: claimant.rsvpId, status: { in: DECIDED }, id: { not: claim.id } }, select: { ...usageSelect, eligibilitySnapshot: true } }),
    tx.expenseClaim.findMany({ where: { policyId: claim.policyId, status: { in: DECIDED }, id: { not: claim.id } }, select: usageSelect }),
    tx.reimbursementPolicy.findUnique({ where: { id: claim.policyId }, select: { budgetMinor: true, capPerPersonMinor: true } }),
  ]);
  const frozenCap = personCap([snapshot, ...mine.map((row) => readSnapshot(row.eligibilitySnapshot))], policy?.capPerPersonMinor ?? null);
  const personDecided = sumDecided(mine);
  const budgetDecided = sumDecided(all);
  const problem = approvalProblem({ approvedMinor, cap: frozenCap, personDecided, budget: policy?.budgetMinor ?? null, budgetDecided });
  if (problem === "cap") return fail(`That would take this person over ${snapshot.terms.name}'s cap of ${formatMoney(frozenCap, claim.currency)}; approve up to ${formatMoney(frozenCap > personDecided ? frozenCap - personDecided : BigInt(0), claim.currency)}.`);
  if (problem === "budget") {
    const budget = policy?.budgetMinor ?? BigInt(0);
    return fail(`That would take ${snapshot.terms.name} over its budget; ${formatMoney(budget > budgetDecided ? budget - budgetDecided : BigInt(0), claim.currency)} is left.`);
  }
  return ok({ snapshot: snapshotJson({ ...snapshot, approved: recordCheck(evaluation, now) }) });
}

/**
 * For approvers: waiting policy claims whose person no longer qualifies under
 * the frozen terms (a check-in undone, a project disqualified), by claim id,
 * with the reason. Read-only. Claims are grouped by their frozen terms and
 * each group is checked with one query (the resolvers' `candidates`); only
 * claims that fail are evaluated one by one, for the reason.
 */
export async function eligibilityChanges(client: Prisma.TransactionClient, claims: Array<{ id: string; status: string; eventId: string | null; rsvpId: string | null; policyId: string | null; eligibilitySnapshot: Prisma.JsonValue | null }>) {
  const changed = new Map<string, string>();
  const groups = new Map<string, { eventId: string; terms: EligibilityTerms; claims: Array<{ id: string; rsvpId: string }> }>();
  for (const claim of claims) {
    if (claim.status !== ExpenseClaimStatus.SUBMITTED || !claim.policyId) continue;
    const snapshot = readSnapshot(claim.eligibilitySnapshot);
    if (!snapshot || !claim.rsvpId || !claim.eventId) {
      changed.set(claim.id, "The registration no longer exists.");
      continue;
    }
    const terms = eligibilityTerms(snapshot.terms);
    const key = JSON.stringify([claim.eventId, terms]);
    const group = groups.get(key) ?? { eventId: claim.eventId, terms, claims: [] };
    group.claims.push({ id: claim.id, rsvpId: claim.rsvpId });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const rsvpIds = [...new Set(group.claims.map((claim) => claim.rsvpId))];
    const eligible = new Set(await eligibleRegistrationIds(client, group.eventId, group.terms, rsvpIds.length, { id: { in: rsvpIds } }));
    for (const claim of group.claims) {
      if (eligible.has(claim.rsvpId)) continue;
      const claimant = await loadClaimant(client, claim.rsvpId, group.eventId);
      const evaluation = claimant ? await evaluateEligibility(client, claimant, group.terms) : null;
      if (!evaluation?.eligible) changed.set(claim.id, evaluation?.reason ?? "The registration no longer exists.");
    }
  }
  return changed;
}
