import { ExpenseClaimStatus } from "@prisma/client";

/**
 * Cap and budget arithmetic for reimbursement policies (docs/FINANCE.md),
 * kept pure so it is unit tested. Waiting claims count at the amount asked,
 * decided ones at the amount approved; rejected and withdrawn ones not at all.
 */

const ZERO = BigInt(0);

export type CountedClaim = { status: ExpenseClaimStatus | string; amountMinor: bigint; approvedMinor: bigint | null };

export function countedMinor(claim: CountedClaim): bigint {
  if (claim.status === ExpenseClaimStatus.SUBMITTED) return claim.amountMinor;
  if (claim.status === ExpenseClaimStatus.APPROVED || claim.status === ExpenseClaimStatus.PAID) return claim.approvedMinor ?? ZERO;
  return ZERO;
}

export function sumCounted(claims: CountedClaim[]): bigint {
  return claims.reduce((sum, claim) => sum + countedMinor(claim), ZERO);
}

/** Only decided money (approved or paid): what an approval is checked against. */
export function sumDecided(claims: CountedClaim[]): bigint {
  return claims.reduce((sum, claim) => sum + (claim.status === ExpenseClaimStatus.SUBMITTED ? ZERO : countedMinor(claim)), ZERO);
}

const atLeastZero = (value: bigint) => (value > ZERO ? value : ZERO);

/** What is left for one person (their cap) and in the policy (its budget, when it has one); `left` is the smaller. */
export function remaining(params: { capPerPerson: bigint; personUsed: bigint; budget: bigint | null; budgetUsed: bigint }) {
  const person = atLeastZero(params.capPerPerson - params.personUsed);
  const budget = params.budget == null ? null : atLeastZero(params.budget - params.budgetUsed);
  return { person, budget, left: budget != null && budget < person ? budget : person };
}

export type ClaimWindow = { claimOpensAt: Date | null; claimClosesAt: Date | null };

export function windowState(window: ClaimWindow, now: Date): "upcoming" | "open" | "closed" {
  if (window.claimOpensAt && now < window.claimOpensAt) return "upcoming";
  if (window.claimClosesAt && now >= window.claimClosesAt) return "closed";
  return "open";
}

/** An approval keeps the person within the cap frozen at submission and the policy within its current budget. */
export function approvalProblem(params: { approvedMinor: bigint; frozenCap: bigint; personDecided: bigint; budget: bigint | null; budgetDecided: bigint }): "cap" | "budget" | null {
  if (params.personDecided + params.approvedMinor > params.frozenCap) return "cap";
  if (params.budget != null && params.budgetDecided + params.approvedMinor > params.budget) return "budget";
  return null;
}
