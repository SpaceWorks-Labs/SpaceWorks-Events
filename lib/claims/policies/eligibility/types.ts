import type { CrewKind, Prisma, ReimbursementEligibility, RsvpStatus } from "@prisma/client";

/** The registration a claim is for: a participant's or a crew member's ticket. */
export type Claimant = {
  rsvpId: string;
  eventId: string;
  status: RsvpStatus;
  isCrew: boolean;
  teamId: string | null;
  checkedInAt: Date | null;
};

/** The part of a policy's terms that decides who qualifies (frozen into each claim's snapshot). */
export type EligibilityTerms = {
  eligibility: ReimbursementEligibility;
  judgingRoundId: string | null;
  mentoringRoundId: string | null;
  requireFinalistsPublished: boolean;
  attendanceRequired: boolean;
  /** CREW only: these crew kinds; empty is every crew member. */
  crewKinds: CrewKind[];
};

/** Plain facts kept in the snapshot: ids, statuses and flags, never names or contact details. */
export type EligibilityFacts = Record<string, string | boolean | null>;

export type Evaluation = { eligible: boolean; reason: string | null; facts: EligibilityFacts };

export type EligibilityClient = Prisma.TransactionClient;

/**
 * One eligibility kind (docs/FINANCE.md "Reimbursement policies"). The
 * registry (./index.ts) checks the registration is confirmed and, when the
 * policy asks, checked in; a resolver decides only its own stage rule.
 */
export type EligibilityResolver = {
  /** The policy column holding this kind's stage id (the CHECK's column), or null. */
  stage: "judgingRoundId" | "mentoringRoundId" | null;
  /** Whether this registration qualifies now, with the facts behind it. */
  evaluate(client: EligibilityClient, claimant: Claimant, terms: EligibilityTerms): Promise<Evaluation>;
  /** Registrations that qualify now, as a filter on the event's confirmed registrations. */
  candidates(client: EligibilityClient, eventId: string, terms: EligibilityTerms): Promise<Prisma.RSVPWhereInput>;
};

export const yes = (facts: EligibilityFacts = {}): Evaluation => ({ eligible: true, reason: null, facts });
export const no = (reason: string, facts: EligibilityFacts = {}): Evaluation => ({ eligible: false, reason, facts });
/** A filter that matches nobody. */
export const NOBODY: Prisma.RSVPWhereInput = { id: { in: [] } };
