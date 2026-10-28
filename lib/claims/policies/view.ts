import "server-only";

import { ExpenseClaimStatus, JudgingRoundEntrySource, MentoringRoundStatus, type Prisma } from "@prisma/client";
import { formatMoney, minorToDecimalString } from "@/lib/payments/money";
import { zonedDatetimeLocalValue } from "@/lib/timeZone";
import { CATEGORY_LABELS } from "../shared";
import { ELIGIBILITY_LABELS } from "../policyLabels";
import { policyUsage } from "./claims";
import { evaluateEligibility, type Claimant } from "./eligibility";
import { remaining, sumCounted, windowState } from "./math";

/** Reading reimbursement policies for the Finance tab, the ticket page and the mobile API (docs/FINANCE.md). */

const COUNTED = [ExpenseClaimStatus.SUBMITTED, ExpenseClaimStatus.APPROVED, ExpenseClaimStatus.PAID];

/** Every policy of the event with its stage's name, how many claims it has and what it has used of its budget. */
export async function listPolicies(client: Prisma.TransactionClient, eventId: string) {
  const policies = await client.reimbursementPolicy.findMany({
    where: { eventId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { judgingRound: { select: { name: true } }, mentoringRound: { select: { label: true } }, _count: { select: { claims: true } } },
  });
  const usage = policies.length
    ? await client.expenseClaim.groupBy({ by: ["policyId", "status"], where: { policyId: { in: policies.map((policy) => policy.id) }, status: { in: COUNTED } }, _sum: { amountMinor: true, approvedMinor: true } })
    : [];
  return policies.map(({ judgingRound, mentoringRound, _count, ...policy }) => ({
    ...policy,
    stageName: judgingRound?.name ?? mentoringRound?.label ?? null,
    claimCount: _count.claims,
    budgetUsed: sumCounted(usage.filter((row) => row.policyId === policy.id).map((row) => ({ status: row.status, amountMinor: row._sum.amountMinor ?? BigInt(0), approvedMinor: row._sum.approvedMinor }))),
  }));
}

export type ListedPolicy = Awaited<ReturnType<typeof listPolicies>>[number];

export function whoLabel(policy: { eligibility: string; stageName: string | null }) {
  const label = ELIGIBILITY_LABELS[policy.eligibility] ?? policy.eligibility;
  return policy.stageName ? `${label}: ${policy.stageName}` : label;
}

/** The rounds a policy form can pick: judging rounds that take advanced projects, and mentoring rounds not skipped. */
export async function policyStageOptions(client: Prisma.TransactionClient, eventId: string) {
  const [judging, mentoring] = await Promise.all([
    client.judgingRound.findMany({ where: { eventId, entrySource: JudgingRoundEntrySource.ADVANCED }, orderBy: { position: "asc" }, select: { id: true, name: true } }),
    client.mentoringRound.findMany({ where: { eventId, status: { not: MentoringRoundStatus.SKIPPED } }, orderBy: { position: "asc" }, select: { id: true, label: true } }),
  ]);
  return { judgingRounds: judging.map((round) => ({ id: round.id, name: round.name })), mentoringRounds: mentoring.map((round) => ({ id: round.id, name: round.label })) };
}

/** Policies for the Finance tab: display values plus the edit form's inputs. */
export function policyAdminRows(policies: ListedPolicy[], currency: string, timeZone: string, now = new Date()) {
  const money = (value: bigint) => formatMoney(value, currency);
  return policies.map((policy) => ({
    id: policy.id,
    name: policy.name,
    who: whoLabel(policy),
    cap: money(policy.capPerPersonMinor),
    categories: policy.categories.map((category) => CATEGORY_LABELS[category]).join(", "),
    budget: policy.budgetMinor != null ? { total: money(policy.budgetMinor), used: money(policy.budgetUsed), left: money(policy.budgetMinor > policy.budgetUsed ? policy.budgetMinor - policy.budgetUsed : BigInt(0)) } : null,
    used: money(policy.budgetUsed),
    window: windowState(policy, now),
    claimOpensAt: policy.claimOpensAt?.toISOString() ?? null,
    claimClosesAt: policy.claimClosesAt?.toISOString() ?? null,
    attendanceRequired: policy.attendanceRequired,
    active: policy.active,
    claimCount: policy.claimCount,
    input: {
      policyId: policy.id,
      name: policy.name,
      eligibility: policy.eligibility as string,
      judgingRoundId: policy.judgingRoundId ?? "",
      mentoringRoundId: policy.mentoringRoundId ?? "",
      requireFinalistsPublished: policy.requireFinalistsPublished,
      cap: minorToDecimalString(policy.capPerPersonMinor, currency),
      categories: [...policy.categories] as string[],
      claimOpensAt: policy.claimOpensAt ? zonedDatetimeLocalValue(policy.claimOpensAt, timeZone) : "",
      claimClosesAt: policy.claimClosesAt ? zonedDatetimeLocalValue(policy.claimClosesAt, timeZone) : "",
      attendanceRequired: policy.attendanceRequired,
      budget: policy.budgetMinor != null ? minorToDecimalString(policy.budgetMinor, currency) : "",
      active: policy.active,
      notifyWhenAvailable: policy.notifyWhenAvailable,
    },
  }));
}

export type PolicyAdminRow = ReturnType<typeof policyAdminRows>[number];

/**
 * The open policies this registration may claim under now, each with what is
 * left for them (the smaller of their cap and the policy's budget).
 */
export async function availablePolicies(client: Prisma.TransactionClient, claimant: Claimant, now = new Date()) {
  const policies = await client.reimbursementPolicy.findMany({
    where: { eventId: claimant.eventId, active: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { judgingRound: { select: { name: true } }, mentoringRound: { select: { label: true } } },
  });
  const open = [];
  for (const policy of policies) {
    if (windowState(policy, now) !== "open") continue;
    if (!(await evaluateEligibility(client, claimant, policy)).eligible) continue;
    const usage = await policyUsage(client, policy.id, claimant.rsvpId);
    const left = remaining({ capPerPerson: policy.capPerPersonMinor, personUsed: usage.personUsed, budget: policy.budgetMinor, budgetUsed: usage.budgetUsed });
    open.push({ policy: { ...policy, stageName: policy.judgingRound?.name ?? policy.mentoringRound?.label ?? null }, left: left.left });
  }
  return open;
}
