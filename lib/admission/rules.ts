import type { AdmissionDecisionOutcome, AdmissionStatus, RsvpStatus } from "@prisma/client";

/*
 * Applications and shortlisting (docs/ADMISSION.md): the pure rules, unit
 * tested without a database (tests/unit/admission-rules.test.ts). The cores in
 * lib/admission/* read the event, feed these, and write the result.
 */

export const ADMISSION_STAGES_LIMIT = 10;
export const ADMISSION_STAGE_NAME_MAX = 80;
export const ADMISSION_CRITERIA_LIMIT = 10;
export const ADMISSION_CRITERION_MAX = 60;
export const ADMISSION_GUIDANCE_MAX = 2000;
export const ADMISSION_NOTES_MAX = 2000;
export const ADMISSION_DECISION_NOTE_MAX = 200;
export const ADMISSION_OVERRIDE_REASON_MAX = 500;
export const ADMISSION_RSVP_DAYS_MIN = 1;
export const ADMISSION_RSVP_DAYS_MAX = 30;
export const REVIEWS_PER_APPLICATION_MIN = 1;
export const REVIEWS_PER_APPLICATION_MAX = 20;
/** The single score a stage without criteria asks for. */
export const OVERALL_CRITERION = "overall";
export const SCORE_MIN = 1;
export const SCORE_MAX = 5;
/** Offer reminders go out once, this long before the offer runs out. */
export const OFFER_REMINDER_BEFORE_MS = 24 * 60 * 60_000;
/** The longest an organiser can extend an offer by at once. */
export const OFFER_EXTENSION_MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

/** Paid places on a team event are paid once by the leader (PER_TEAM); paying per member isn't supported with applications yet. */
export const PER_MEMBER_PAID_REFUSAL = "On a team event with paid tickets, applications need the team leader to pay once for the team. Set who pays to \"The team leader\" first (paying per member isn't supported with applications yet).";

/** Applications that hold an offer: counted against the offer capacity. */
export const OFFER_HOLDING: readonly AdmissionStatus[] = ["OFFERED", "ACCEPTED"];
/** Applications still open to a decision. */
export const DECIDABLE: readonly AdmissionStatus[] = ["IN_REVIEW", "WAITLISTED"];
/** Closed for good: nothing changes them again. */
export const CLOSED_STATUSES: readonly AdmissionStatus[] = ["REJECTED", "DECLINED", "EXPIRED", "WITHDRAWN"];

/** The registration status that mirrors an application status (CONFIRMED and PENDING_PAYMENT come from the offer flow). */
export function registrationStatusFor(status: AdmissionStatus): RsvpStatus {
  switch (status) {
    case "IN_REVIEW":
    case "OFFERED":
      return "PENDING_APPROVAL";
    case "WAITLISTED":
      return "WAITLISTED";
    case "ACCEPTED":
      return "CONFIRMED";
    default:
      return "REJECTED";
  }
}

/** Which decisions can be drafted for an application in `status`, at a stage that is or isn't the last one. */
export function allowedOutcomes(status: AdmissionStatus, hasNextStage: boolean): AdmissionDecisionOutcome[] {
  if (status === "IN_REVIEW") return hasNextStage ? ["ADVANCE", "ACCEPT", "WAITLIST", "REJECT"] : ["ACCEPT", "WAITLIST", "REJECT"];
  if (status === "WAITLISTED") return ["ACCEPT", "REJECT"];
  return [];
}

/** The offer capacity in force: the admission setting, else the event capacity, else none. */
export function offerCeiling(event: { admissionOfferCapacity: number | null; capacity: number | null }): number | null {
  return event.admissionOfferCapacity ?? event.capacity ?? null;
}

/** Offers that can still go out now: null when there is no ceiling. */
export function offersLeft(ceiling: number | null, holding: number): number | null {
  return ceiling == null ? null : Math.max(0, ceiling - holding);
}

/**
 * The respond-by time of a new offer: `days` from now, but never after the
 * event starts (an offer can't outlive the event it is for). Never in the past.
 */
export function respondByFor(now: Date, days: number, eventStart: Date): Date {
  const wanted = new Date(now.getTime() + days * DAY_MS);
  return wanted > eventStart ? (eventStart > now ? eventStart : now) : wanted;
}

/** A new respond-by for an extension: in the future, before the event starts, at most OFFER_EXTENSION_MAX_DAYS away. */
export function extensionRefusal(now: Date, current: Date | null, next: Date, eventStart: Date): string | null {
  if (next <= now) return "Choose a time in the future.";
  if (current && next <= current) return "Choose a later time than the current deadline.";
  if (next > eventStart) return "An offer can't run past the start of the event.";
  if (next.getTime() - now.getTime() > OFFER_EXTENSION_MAX_DAYS * DAY_MS) return `Extend by at most ${OFFER_EXTENSION_MAX_DAYS} days at a time.`;
  return null;
}

/**
 * Reviews that count towards a stage's target: on the current answers, by a
 * reviewer who can still review the stage and has no conflict with the
 * application. Distinct reviewers only.
 */
export function countedReviewers(
  reviews: ReadonlyArray<{ reviewerUserId: string; answersRevision: number }>,
  answersRevision: number,
  canReview: (userId: string) => boolean,
  conflicted: (userId: string) => boolean,
): number {
  const counted = new Set<string>();
  for (const review of reviews) {
    if (review.answersRevision !== answersRevision) continue;
    if (!canReview(review.reviewerUserId) || conflicted(review.reviewerUserId)) continue;
    counted.add(review.reviewerUserId);
  }
  return counted.size;
}

/** Whether a decision may be released: enough counted reviews, or an override reason. */
export function coverageMet(counted: number, target: number, overrideReason: string | null | undefined): boolean {
  return counted >= target || Boolean(overrideReason?.trim());
}

export type QueueCandidate = { id: string; queuedAt: Date; fits: boolean; reason?: string };

/**
 * First in, first offered: the waitlist in queue order (queued time, then
 * id). A candidate that can't take a place now (a full ticket type, a team
 * short of members) is skipped with its reason, and the next one is tried.
 */
export function promotionOrder(candidates: readonly QueueCandidate[], places: number | null): { offer: string[]; skipped: Array<{ id: string; reason: string }> } {
  const sorted = [...candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const offer: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const candidate of sorted) {
    if (places != null && offer.length >= places) break;
    if (!candidate.fits) {
      skipped.push({ id: candidate.id, reason: candidate.reason ?? "It can't take a place right now." });
      continue;
    }
    offer.push(candidate.id);
  }
  return { offer, skipped };
}

/** Validate review scores against a stage's criteria: every criterion scored SCORE_MIN..SCORE_MAX, nothing else. */
export function normaliseScores(criteria: readonly string[], input: Record<string, unknown>): Record<string, number> | null {
  const keys = criteria.length ? criteria : [OVERALL_CRITERION];
  const scores: Record<string, number> = {};
  for (const key of keys) {
    const value = input[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < SCORE_MIN || value > SCORE_MAX) return null;
    scores[key] = value;
  }
  if (Object.keys(input).some((key) => !keys.includes(key))) return null;
  return scores;
}

/** The mean of a review's scores, one decimal. */
export function reviewMean(scores: Record<string, number>): number {
  const values = Object.values(scores);
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

/**
 * Words for the applicant and the organiser. Every event says "application";
 * hackathons (events with submissions) may say "hackathon" in a heading, but
 * the flow reads the same everywhere.
 */
export function admissionNouns(isHackathon: boolean) {
  return {
    section: "Applications",
    applicant: "Your application",
    eventKind: isHackathon ? "hackathon" : "event",
  };
}

export const STATUS_LABELS: Record<AdmissionStatus, string> = {
  IN_REVIEW: "In review",
  OFFERED: "Offered a place",
  WAITLISTED: "Waitlisted",
  ACCEPTED: "Accepted",
  REJECTED: "Not successful",
  DECLINED: "Declined",
  EXPIRED: "Offer expired",
  WITHDRAWN: "Withdrawn",
};

export const OUTCOME_LABELS: Record<AdmissionDecisionOutcome, string> = {
  ADVANCE: "Advance to next stage",
  ACCEPT: "Offer a place",
  WAITLIST: "Waitlist",
  REJECT: "Decline",
};
