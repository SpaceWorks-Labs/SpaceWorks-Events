import "server-only";

import { currentMobileActor } from "@/lib/requestActor";

/**
 * Run a Server Action body for `actorUserId`, who must be this request's
 * actor (lib/requestActor.ts). Inside a mobile request auth() presents that
 * actor, so the action's own authentication, authorisation, staff
 * authenticator check, rate limits, audit, webhooks and notifications all
 * apply unchanged. Anything else fails closed.
 */
export async function forUser<T>(actorUserId: string | null, run: () => Promise<T>): Promise<T> {
  const actor = currentMobileActor();
  if (!actorUserId || !actor || actor.userId !== actorUserId) throw new Error("This request does not act for that user.");
  return run();
}
