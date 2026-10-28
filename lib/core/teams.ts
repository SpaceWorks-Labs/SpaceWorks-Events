import "server-only";

/**
 * Team registration mutation cores (docs/TEAMS.md), shared by Server Actions
 * and any future API surface. Callers authenticate, rate limit, audit, and
 * revalidate; these functions own the rules.
 *
 * Every mutation takes the Event row lock (`SELECT ... FOR UPDATE`) first,
 * so team changes serialise with RSVP creation, cancellation, approval, and
 * capacity edits. A team id from the browser is always re-read together with
 * its `eventId` inside that transaction, and leader authority is re-checked
 * under the lock (a rotated management token or a transferred leadership
 * takes effect immediately).
 *
 * The parts live in lib/core/teams/; this module is their public entry.
 */

export {
  INVITE_ONLY_ADD_REFUSED,
  type JoinRequestActor,
  type OrganiserEventContext,
  type TeamLeaderAuth,
  type TeamResult,
  type TicketHolder,
} from "./teams/shared";
export * from "./teams/resolvers";
export * from "./teams/registration";
export * from "./teams/leader";
export * from "./teams/matching";
export * from "./teams/organiser";
export * from "./teams/snapshots";
export {
  decodeKeysetCursor,
  decodeTeamCursor,
  encodeKeysetCursor,
  encodeTeamCursor,
  escapeLikePattern,
  joinRequestPageQuerySchema,
  matchingListQuerySchema,
  TEAM_MATCHING_PAGE_SIZE,
  type CursorPage,
} from "./teams/paging";
export * from "./teams/seekers";
export * from "./teams/teamPage";
export * from "./teams/seekerView";
export * from "./teams/organiserList";
