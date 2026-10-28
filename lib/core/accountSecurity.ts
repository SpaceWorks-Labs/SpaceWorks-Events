import "server-only";

import { revokeAllSessions } from "@/app/actions/security";
import { forUser } from "./actor";

/**
 * Sign out everywhere (web sessions, the authenticator proof and every app
 * session), by the account page's action body: it needs a credential proved
 * in the last 10 minutes (REAUTH_REQUIRED otherwise).
 */
export const revokeAllSessionsForUser = (actorUserId: string | null) => forUser(actorUserId, () => revokeAllSessions());
