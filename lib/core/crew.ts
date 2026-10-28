import "server-only";

/**
 * Event crew cores (docs/CREW.md): the people running an event. Every member
 * owns one free CONFIRMED `RSVP` with `isCrew` for their QR ticket and
 * check-in. Crew count in headcounts but never against `Event.capacity`
 * (`takesCapacity`, `seatTakingWhere` in lib/payments/holds.ts), never buy
 * tickets, never join teams or projects, and are added, edited and removed
 * only here, never through the guest flows.
 *
 * Callers authorise first: organiser functions take an OrganiserCrewContext
 * resolved with MANAGE_REGISTRATIONS; the join-link functions take the raw
 * link token, which is the capability. The parts live in lib/core/crew/.
 */

export * from "./crew/shared";
export * from "./crew/members";
export * from "./crew/joinLink";
export * from "./crew/public";
