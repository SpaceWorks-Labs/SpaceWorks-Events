import { nextSubmissionForJudge } from "@/lib/core/judging";
import { mobileError, mobileOk, parseQuery } from "@/lib/mobile/http";
import { judgingRoute, roundQuerySchema, toJudgeDetail } from "@/lib/mobile/judging";
import { judgeNextDtoSchema } from "@/lib/mobile/schemas";

/**
 * "Score next project", picked on the server by the web's rule: one this judge
 * started, then the fewest submitted reviews, then the oldest. `next` is null
 * when nothing is left or judging is not open.
 */
export const GET = judgingRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/judging/next", "action", async (request, _params, { judge }) => {
  const query = parseQuery(request, roundQuerySchema);
  if ("response" in query) return query.response;
  const result = await nextSubmissionForJudge(judge, { roundId: query.data.roundId ?? null });
  if (!result) return mobileError("NOT_FOUND");
  return mobileOk(judgeNextDtoSchema.parse({ next: result.next ? toJudgeDetail(result.next) : null, remaining: result.remaining }));
});
