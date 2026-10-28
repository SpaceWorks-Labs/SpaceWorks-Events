import { mobileError, mobileOk, parseQuery } from "@/lib/mobile/http";
import { judgingRoute, loadJudgingCriteriaForMobile, roundQuerySchema } from "@/lib/mobile/judging";

/** The rubric (name, description, weight, max score) and the judging status. */
export const GET = judgingRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/judging/criteria", "action", async (request, _params, { judge }) => {
  const query = parseQuery(request, roundQuerySchema);
  if ("response" in query) return query.response;
  const criteria = await loadJudgingCriteriaForMobile(judge, query.data.roundId);
  return criteria ? mobileOk(criteria) : mobileError("NOT_FOUND");
});
