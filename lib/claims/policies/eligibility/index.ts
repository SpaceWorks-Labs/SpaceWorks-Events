import "server-only";

import { ReimbursementEligibility, RsvpStatus, type Prisma } from "@prisma/client";
import { judgingRoundEntry } from "./judgingRound";
import { mentoringRound } from "./mentoringRound";
import { confirmedParticipant, crewMember } from "./registration";
import { no, type Claimant, type EligibilityClient, type EligibilityResolver, type EligibilityTerms, type Evaluation } from "./types";

export type { Claimant, EligibilityTerms, Evaluation } from "./types";

/**
 * Who a reimbursement policy is for (docs/FINANCE.md "Reimbursement
 * policies"): one resolver per eligibility kind. A new kind (an admission
 * stage) adds its enum value, its stage column and CHECK, and one entry here;
 * the Record type makes a missing resolver a compile error.
 */
export const ELIGIBILITY_RESOLVERS: Record<ReimbursementEligibility, EligibilityResolver> = {
  [ReimbursementEligibility.CONFIRMED_PARTICIPANT]: confirmedParticipant,
  [ReimbursementEligibility.CREW]: crewMember,
  [ReimbursementEligibility.JUDGING_ROUND_ENTRY]: judgingRoundEntry,
  [ReimbursementEligibility.MENTORING_ROUND]: mentoringRound,
};

/** The stage column a kind uses, so a policy form sets exactly that one. */
export function stageColumn(eligibility: ReimbursementEligibility) {
  return ELIGIBILITY_RESOLVERS[eligibility].stage;
}

/**
 * Whether a registration qualifies under the terms right now. Every kind
 * needs a confirmed registration (paid or free: payment is never checked
 * here), and a check-in when the terms ask for attendance.
 */
export async function evaluateEligibility(client: EligibilityClient, claimant: Claimant, terms: EligibilityTerms): Promise<Evaluation> {
  const base = { registrationStatus: claimant.status, checkedIn: claimant.checkedInAt != null };
  if (claimant.status !== RsvpStatus.CONFIRMED) return no("The registration is no longer confirmed.", base);
  if (terms.attendanceRequired && !claimant.checkedInAt) return no("Not checked in at the event.", base);
  const result = await ELIGIBILITY_RESOLVERS[terms.eligibility].evaluate(client, claimant, terms);
  return { ...result, facts: { ...base, ...result.facts } };
}

/** Load a registration as a claimant, or null when it isn't on this event. */
export async function loadClaimant(client: EligibilityClient, rsvpId: string, eventId: string): Promise<Claimant | null> {
  const rsvp = await client.rSVP.findFirst({ where: { id: rsvpId, eventId }, select: { id: true, status: true, isCrew: true, teamId: true, checkedInAt: true } });
  return rsvp ? { rsvpId: rsvp.id, eventId, status: rsvp.status, isCrew: rsvp.isCrew, teamId: rsvp.teamId, checkedInAt: rsvp.checkedInAt } : null;
}

/** Registrations of the event that qualify under the terms now (and match `extra`), oldest first, at most `limit`. */
export async function eligibleRegistrationIds(client: EligibilityClient, eventId: string, terms: EligibilityTerms, limit: number, extra: Prisma.RSVPWhereInput = {}): Promise<string[]> {
  const filter: Prisma.RSVPWhereInput = await ELIGIBILITY_RESOLVERS[terms.eligibility].candidates(client, eventId, terms);
  const rows = await client.rSVP.findMany({
    where: { AND: [{ eventId, status: RsvpStatus.CONFIRMED, ...(terms.attendanceRequired ? { checkedInAt: { not: null } } : {}) }, filter, extra] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
