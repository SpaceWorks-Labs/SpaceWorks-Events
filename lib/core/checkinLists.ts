import "server-only";

/*
 * Custom check-in lists: the mutation core shared by the Server Actions in
 * app/actions/checkin-lists.ts and, later, the mobile API. Everything is
 * scoped to one standalone event of the organisation named by the caller.
 *
 * - Managing lists (create, rename, reorder, archive, restore, the
 *   requires-entry switch) needs organisation OWNER/ADMIN or the event's
 *   `EDIT_DETAILS` grant.
 * - Checking people into or out of a list needs OWNER/ADMIN or `CHECK_IN`,
 *   exactly like entry check-in, and uses the same `checkin` rate limit.
 *
 * An event outside the organisation, or one the caller cannot open at all,
 * answers "Event not found." (mapped to NOT_FOUND by the mobile layer).
 *
 * The parts live in lib/core/checkinLists/; this module is their public entry.
 */

export type { CheckInListOptions, CheckInListSummary, ListCheckInResultData, ListLookupRow } from "./checkinLists/shared";
export * from "./checkinLists/manage";
export * from "./checkinLists/desk";
