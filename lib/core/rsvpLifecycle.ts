import "server-only";

import { approveRsvp, promoteFromWaitlist, reacceptRsvp, rejectRsvp } from "@/app/actions/rsvp-lifecycle";
import { forUser } from "./actor";

/*
 * Registration decisions for API callers, by the dashboard's own action
 * bodies: paid requests are offered a payment link instead of a seat,
 * declined paid orders are refunded, waitlists fill, webhooks and notices go
 * out after commit. Input: { organisationSlug, rsvpId, eventId | eventInstanceId }.
 */
export const approveRsvpForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => approveRsvp(input));
export const rejectRsvpForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => rejectRsvp(input));
export const reacceptRsvpForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => reacceptRsvp(input));
export const promoteFromWaitlistForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => promoteFromWaitlist(input));
