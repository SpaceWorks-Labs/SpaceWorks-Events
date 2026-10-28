/**
 * Machine-readable reasons an action refuses, for API clients (the mobile
 * API and the machine API). The `error` text beside a code stays the
 * UI-safe message the website shows.
 */
export type ActionErrorCode =
  | "TEAM_REQUIRED"
  /** A team registration changes only as a whole team. */
  | "TEAM_MEMBER"
  /** Money was taken: the order's refund rules apply instead. */
  | "PAID_ORDER"
  | "CAPACITY_FULL"
  | "REGISTRATION_CLOSED"
  /** Approving a team below the event's minimum team size. */
  | "TEAM_INCOMPLETE"
  /** Judging is not OPEN, so scores and reviews are frozen. */
  | "JUDGING_CLOSED"
  /** Submitting a review before every criterion is scored (or with no rubric). */
  | "INCOMPLETE_SCORES"
  /** A submission this judge may not score (not submitted, unassigned, conflict of interest, another event's). */
  | "NOT_VISIBLE"
  /** An application's registration, team or order (docs/ADMISSION.md): decided and paid only through the Applications flow. */
  | "ADMISSION_MANAGED";
