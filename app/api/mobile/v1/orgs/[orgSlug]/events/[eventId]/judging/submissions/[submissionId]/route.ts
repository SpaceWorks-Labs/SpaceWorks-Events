import { parseQuery } from "@/lib/mobile/http";
import { judgeDetailResponse, judgingRoute, roundQuerySchema } from "@/lib/mobile/judging";

type Params = { orgSlug: string; eventId: string; submissionId: string };

/** One project for scoring, with this judge's own saved scores and private comment only. */
export const GET = judgingRoute<Params>("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/judging/submissions/:submissionId", "action", async (request, { submissionId }, { judge }) => {
  const query = parseQuery(request, roundQuerySchema);
  if ("response" in query) return query.response;
  return judgeDetailResponse(judge, submissionId, query.data.roundId);
});
