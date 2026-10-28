import "server-only";

import { setEventSessionDelay } from "@/app/actions/event-website/schedule";
import { forUser } from "./actor";

/* Live programme delays for API callers (PUBLISH_AND_SCHEDULE), by the dashboard's action body. */
export const setEventSessionDelayForUser = (actorUserId: string | null, input: unknown) => forUser(actorUserId, () => setEventSessionDelay(input));
