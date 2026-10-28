import { CrewKind, ExpenseCategory, ReimbursementEligibility, type Prisma, type ReimbursementPolicy } from "@prisma/client";
import { z } from "zod";
import type { EligibilityTerms, Evaluation } from "./eligibility/types";

/**
 * ExpenseClaim.eligibilitySnapshot (docs/FINANCE.md "Reimbursement
 * policies"): the policy's terms frozen when the claim was filed, so a later
 * policy edit never rewrites them, and the eligibility evaluated at filing
 * and again at approval. Ids, flags and amounts only.
 */

const fact = z.union([z.string().max(200), z.boolean(), z.null()]);
const check = z.object({ at: z.string(), eligible: z.boolean(), reason: z.string().max(200).nullable(), facts: z.record(z.string().max(40), fact) }).strict();

const termsSchema = z.object({
  policyId: z.string(),
  name: z.string(),
  eligibility: z.nativeEnum(ReimbursementEligibility),
  judgingRoundId: z.string().nullable(),
  mentoringRoundId: z.string().nullable(),
  requireFinalistsPublished: z.boolean(),
  attendanceRequired: z.boolean(),
  crewKinds: z.array(z.nativeEnum(CrewKind)).default([]),
  admissionStageId: z.string().nullable().default(null),
  requireAccepted: z.boolean().default(false),
  capPerPersonMinor: z.string().regex(/^\d+$/),
  categories: z.array(z.nativeEnum(ExpenseCategory)),
  claimOpensAt: z.string().nullable(),
  claimClosesAt: z.string().nullable(),
}).strict();

const snapshotSchema = z.object({ version: z.literal(1), terms: termsSchema, submitted: check, approved: check.optional() }).strict();

export type FrozenTerms = z.infer<typeof termsSchema>;
export type EligibilityCheck = z.infer<typeof check>;
export type EligibilitySnapshot = z.infer<typeof snapshotSchema>;

export function freezeTerms(policy: Pick<ReimbursementPolicy, "id" | "name" | "eligibility" | "judgingRoundId" | "mentoringRoundId" | "requireFinalistsPublished" | "attendanceRequired" | "crewKinds" | "admissionStageId" | "requireAccepted" | "capPerPersonMinor" | "categories" | "claimOpensAt" | "claimClosesAt">): FrozenTerms {
  return {
    policyId: policy.id,
    name: policy.name,
    eligibility: policy.eligibility,
    judgingRoundId: policy.judgingRoundId,
    mentoringRoundId: policy.mentoringRoundId,
    requireFinalistsPublished: policy.requireFinalistsPublished,
    attendanceRequired: policy.attendanceRequired,
    crewKinds: [...policy.crewKinds],
    admissionStageId: policy.admissionStageId,
    requireAccepted: policy.requireAccepted,
    capPerPersonMinor: policy.capPerPersonMinor.toString(),
    categories: [...policy.categories],
    claimOpensAt: policy.claimOpensAt?.toISOString() ?? null,
    claimClosesAt: policy.claimClosesAt?.toISOString() ?? null,
  };
}

export function eligibilityTerms(terms: FrozenTerms): EligibilityTerms {
  return { eligibility: terms.eligibility, judgingRoundId: terms.judgingRoundId, mentoringRoundId: terms.mentoringRoundId, requireFinalistsPublished: terms.requireFinalistsPublished, attendanceRequired: terms.attendanceRequired, crewKinds: terms.crewKinds, admissionStageId: terms.admissionStageId, requireAccepted: terms.requireAccepted };
}

export function recordCheck(evaluation: Evaluation, at = new Date()): EligibilityCheck {
  return { at: at.toISOString(), eligible: evaluation.eligible, reason: evaluation.reason, facts: evaluation.facts };
}

export function snapshotJson(snapshot: EligibilitySnapshot): Prisma.InputJsonValue {
  return snapshotSchema.parse(snapshot) as Prisma.InputJsonValue;
}

/** The stored snapshot, or null when it is missing or not one this code wrote. */
export function readSnapshot(value: Prisma.JsonValue | null | undefined): EligibilitySnapshot | null {
  const parsed = snapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
