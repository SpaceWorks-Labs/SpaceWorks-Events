import { z } from "zod";
import { refreshMobileSession } from "@/lib/mobileAuth";
import { mobileError, mobileOk, readJsonBody } from "@/lib/mobile/http";
import { mobileRoute } from "@/lib/mobile/route";
import { sessionDto } from "@/lib/mobile/session";
import { checkRateLimitById, getClientIpFromHeaders } from "@/lib/rateLimit";
import { deviceHash } from "@/lib/loginSecurity";

const bodySchema = z.object({ refreshToken: z.string().min(1).max(256), deviceId: z.string().max(64) }).strict();

export const POST = mobileRoute("POST /api/mobile/v1/auth/refresh", async (request, _params, { baseUrl }) => {
  if (!(await checkRateLimitById("mobileRefresh", `ip:${getClientIpFromHeaders(request.headers)}`))) return mobileError("RATE_LIMITED");
  const body = await readJsonBody(request, 4 * 1024);
  if ("response" in body) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return mobileError("UNAUTHENTICATED");
  // The refresh token works only from the install that signed in.
  const outcome = await refreshMobileSession(parsed.data.refreshToken, deviceHash(parsed.data.deviceId));
  // Unknown, expired, revoked, reused and version-stale tokens look identical.
  if (!outcome.ok) return mobileError("UNAUTHENTICATED");
  return mobileOk(await sessionDto(outcome.session, outcome.userId, baseUrl));
});
