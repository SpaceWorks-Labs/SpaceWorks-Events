import "server-only";

import { countBroadcastRecipients, previewEventBroadcast, sendEventBroadcast, sendEventBroadcastTest } from "@/app/actions/broadcasts";
import { forUser } from "./actor";

/* Guest emails for API callers, by the dashboard's action bodies (the organisation's own mail server, queued in the outbox). */
export const countBroadcastRecipientsForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => countBroadcastRecipients(input));
export const previewEventBroadcastForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => previewEventBroadcast(input));
export const sendEventBroadcastForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => sendEventBroadcast(input));
export const sendEventBroadcastTestForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => sendEventBroadcastTest(input));
