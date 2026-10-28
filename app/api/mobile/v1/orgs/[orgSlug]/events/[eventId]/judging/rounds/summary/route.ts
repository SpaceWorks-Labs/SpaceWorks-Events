import { loadJudgingRounds } from "@/lib/core/judgingRounds";
import { resolveJudgingOrganiser } from "@/lib/judgingAccess";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileError, mobileOk } from "@/lib/mobile/http";
import { judgingRoundsSummaryDtoSchema } from "@/lib/mobile/schemas";

/**
 * Judging → Rounds, read-only (organisation owners and admins): each round's
 * status, entry source, panel size, rubric size, finalists and submitted
 * reviews. Managing rounds stays on the website.
 */
export const GET = eventRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/judging/rounds/summary", null, async (_request, _params, { auth, event }) => {
  const organiser = await resolveJudgingOrganiser(auth.userId, event.organisation.slug, event.event.id);
  if (!organiser) return mobileError("FORBIDDEN");
  const rounds = await loadJudgingRounds(organiser);
  if (!rounds) return mobileError("NOT_FOUND");
  return mobileOk(judgingRoundsSummaryDtoSchema.parse({
    rounds: rounds.map((round) => ({
      id: round.id, name: round.name, position: round.position, status: round.status, entrySource: round.entrySource,
      judgesSeeAll: round.judgesSeeAll, freshEyes: round.freshEyes, reviewsPerProject: round.reviewsPerProject,
      opensAt: round.opensAt?.toISOString() ?? null, closesAt: round.closesAt?.toISOString() ?? null,
      finalistsPublishedAt: round.finalistsPublishedAt?.toISOString() ?? null, finalizedAt: round.finalizedAt?.toISOString() ?? null,
      isCurrent: round.isCurrent, isFinal: round.isFinal, panelSize: round.panelUserIds.length, criteria: round.criteria.length,
      finalists: round.finalists, reviewsSubmitted: round.reviewsSubmitted,
    })),
  }));
});
