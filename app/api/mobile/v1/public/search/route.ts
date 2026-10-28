import { mobileError, mobileOk, parseQuery } from "@/lib/mobile/http";
import { searchQuerySchema } from "@/lib/mobile/inputs";
import { searchPublicEvents } from "@/lib/mobile/publicEvents";
import { mobileRoute } from "@/lib/mobile/route";
import { checkRateLimitById, getClientIpFromHeaders } from "@/lib/rateLimit";

export const GET = mobileRoute("GET /api/mobile/v1/public/search", async (request, _params, { baseUrl }) => {
  if (!(await checkRateLimitById("search", getClientIpFromHeaders(request.headers)))) return mobileError("RATE_LIMITED");
  const query = parseQuery(request, searchQuerySchema);
  if ("response" in query) return query.response;
  return mobileOk(await searchPublicEvents(query.data.q, baseUrl));
});
