import { mobileError, mobileOk, parseQuery } from "@/lib/mobile/http";
import { discoverQuerySchema } from "@/lib/mobile/inputs";
import { listDiscoverEvents } from "@/lib/mobile/publicEvents";
import { mobileRoute } from "@/lib/mobile/route";
import { checkRateLimitById, getClientIpFromHeaders } from "@/lib/rateLimit";

export const GET = mobileRoute("GET /api/mobile/v1/public/discover", async (request, _params, { baseUrl }) => {
  if (!(await checkRateLimitById("search", getClientIpFromHeaders(request.headers)))) return mobileError("RATE_LIMITED");
  const query = parseQuery(request, discoverQuerySchema);
  if ("response" in query) return query.response;
  const result = await listDiscoverEvents({ ...query.data, baseUrl });
  if (!result) return mobileError("INVALID_REQUEST", "Invalid cursor.");
  return mobileOk(result);
});
