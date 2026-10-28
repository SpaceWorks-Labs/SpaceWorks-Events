import { mobileError, mobileOk } from "@/lib/mobile/http";
import { judgingRoute, listJudgeRoundsForMobile } from "@/lib/mobile/judging";

/**
 * The judging rounds this judge may open, in order: rounds that have opened
 * and the current round, never a later DRAFT round. Pass `?roundId=` to the
 * other judging reads to show an earlier round; scores go to the current one.
 */
export const GET = judgingRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/judging/rounds", "action", async (_request, _params, { judge }) => {
  const rounds = await listJudgeRoundsForMobile(judge);
  return rounds ? mobileOk(rounds) : mobileError("NOT_FOUND");
});
