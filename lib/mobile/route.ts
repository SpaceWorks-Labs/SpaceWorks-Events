import "server-only";

import crypto from "node:crypto";
import { withApiMonitoring } from "@/lib/apiMonitor";
import { requireMobileUser, optionalMobileUser, type MobileAuthContext } from "@/lib/mobileAuth";
import { mobileError } from "@/lib/mobile/http";
import { getRequestOrigin } from "@/lib/publicUrl";
import { ANONYMOUS_ACTOR, runAsRequestActor } from "@/lib/requestActor";
import { staffMfaState } from "@/lib/staffMfa";
import { checkRateLimitById } from "@/lib/rateLimit";

/*
 * Route plumbing for /api/mobile/v1: monitoring, a generic INTERNAL_ERROR for
 * unexpected exceptions (category-only logging), bearer authentication and a
 * per-user request limit. An authenticated handler runs as the app session's
 * request actor (lib/requestActor.ts): auth(), the staff authenticator rule and
 * every Server Action body then judge that session, never a cookie.
 */

export type RouteParams<T extends Record<string, string> = Record<string, string>> = { params: Promise<T> };

export type MobileRouteContext = {
  baseUrl: string;
};

export type AuthedRouteContext = MobileRouteContext & { auth: MobileAuthContext };

/** Absolute public origin used for image and link URLs. */
export async function mobileBaseUrl() {
  return (await getRequestOrigin()).replace(/\/$/, "");
}

function userRateKey(userId: string) {
  return `user:${crypto.createHash("sha256").update(userId).digest("hex").slice(0, 32)}`;
}

export function mobileRoute<P extends Record<string, string>>(
  routeId: string,
  handler: (request: Request, params: P, context: MobileRouteContext & { auth: MobileAuthContext | null }) => Promise<Response>,
  options: { optionalAuth?: boolean } = {},
) {
  return withApiMonitoring(routeId, async (request: Request, segment?: RouteParams<P>) => {
    try {
      const params = (await segment?.params) ?? ({} as P);
      const auth = options.optionalAuth ? await optionalMobileUser(request) : null;
      if (options.optionalAuth && request.headers.get("authorization") && !auth) return mobileError("UNAUTHENTICATED");
      const baseUrl = await mobileBaseUrl();
      if (auth && !(await checkRateLimitById("mobileApi", userRateKey(auth.userId)))) return mobileError("RATE_LIMITED");
      // Without a bearer the request still runs as an explicit (anonymous) actor, so auth() is null and never the cookie session.
      return await runAsRequestActor(auth ?? ANONYMOUS_ACTOR, () => handler(request, params, { baseUrl, auth }));
    } catch {
      console.error(`[mobile-api] ${routeId} failed`);
      return mobileError("INTERNAL_ERROR");
    }
  });
}

/**
 * Organiser tools (every orgs/* route) first apply the staff authenticator
 * rule to this app session: STAFF_MFA_REQUIRED until a code is confirmed
 * (POST /auth/mfa or a sign-in with one), STAFF_MFA_ENROLMENT_REQUIRED while
 * the account has no authenticator. The deep permission helpers fail closed
 * as well; this gate only names the reason.
 */
export async function staffGate(userId: string) {
  const state = await staffMfaState(userId);
  if (state === "verify") return mobileError("STAFF_MFA_REQUIRED");
  if (state === "enrol") return mobileError("STAFF_MFA_ENROLMENT_REQUIRED");
  return null;
}

export function authedMobileRoute<P extends Record<string, string>>(
  routeId: string,
  handler: (request: Request, params: P, context: AuthedRouteContext) => Promise<Response>,
  options: { staff?: boolean } = {},
) {
  return withApiMonitoring(routeId, async (request: Request, segment?: RouteParams<P>) => {
    try {
      const auth = await requireMobileUser(request);
      if (!auth) return mobileError("UNAUTHENTICATED");
      if (!(await checkRateLimitById("mobileApi", userRateKey(auth.userId)))) return mobileError("RATE_LIMITED");
      const params = (await segment?.params) ?? ({} as P);
      const baseUrl = await mobileBaseUrl();
      return await runAsRequestActor(auth, async () => {
        const refused = options.staff ? await staffGate(auth.userId) : null;
        return refused ?? handler(request, params, { baseUrl, auth });
      });
    } catch {
      console.error(`[mobile-api] ${routeId} failed`);
      return mobileError("INTERNAL_ERROR");
    }
  });
}
