import { revokeAllSessionsForUser } from "@/lib/core/accountSecurity";
import { mobileActionError, mobileError, mobileOk } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";
import { hasRecentAuthentication } from "@/lib/reauth";

/**
 * "Sign out everywhere": the web security page's own body (web sessions, the
 * authenticator proof and every app session). Like the web it needs a
 * credential proved in the last 10 minutes (REAUTH_REQUIRED: sign in again).
 */
export const POST = authedMobileRoute("POST /api/mobile/v1/auth/logout-all", async (_request, _params, { auth }) => {
  if (!(await hasRecentAuthentication())) return mobileError("REAUTH_REQUIRED");
  const result = await revokeAllSessionsForUser(auth.userId);
  if (!result.ok) return mobileActionError(result);
  return mobileOk(null);
});
