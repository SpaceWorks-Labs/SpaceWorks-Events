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
  | "REGISTRATION_CLOSED";
