/**
 * Labels for reimbursement policies (docs/FINANCE.md "Reimbursement
 * policies"), shared by server views and client forms: no server imports.
 */

export const ELIGIBILITY_LABELS: Record<string, string> = {
  CONFIRMED_PARTICIPANT: "Confirmed participants",
  CREW: "Crew",
  JUDGING_ROUND_ENTRY: "Projects in a judging round",
  MENTORING_ROUND: "Teams mentored in a round",
};

/** Which picker a kind needs on the policy form. */
export const ELIGIBILITY_STAGE: Record<string, "judging" | "mentoring" | null> = {
  CONFIRMED_PARTICIPANT: null,
  CREW: null,
  JUDGING_ROUND_ENTRY: "judging",
  MENTORING_ROUND: "mentoring",
};
