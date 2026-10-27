import "server-only";

import { addManualRsvp, deleteRsvp, restoreRsvp, updateRsvpRegistration } from "@/app/actions/rsvp-admin";
import { forUser } from "./actor";

/* Guest-list administration for API callers, by the dashboard's action bodies (paid tickets refuse removal: PAID_ORDER). */
export const addManualRsvpForUser = (actorUserId: string | null, input: Parameters<typeof addManualRsvp>[0]) => forUser(actorUserId, () => addManualRsvp(input));
export const updateRsvpRegistrationForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => updateRsvpRegistration(input));
export const deleteRsvpForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => deleteRsvp(input));
export const restoreRsvpForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => restoreRsvp(input));
