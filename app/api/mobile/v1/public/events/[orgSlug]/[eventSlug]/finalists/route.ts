import { loadPublicFinalists } from "@/lib/core/judgingRounds";
import { mobileError, mobileOk, notFound } from "@/lib/mobile/http";
import { mobileRoute } from "@/lib/mobile/route";
import { publicFinalistsDtoSchema } from "@/lib/mobile/schemas";
import { resolvePublicJudgingEvent } from "@/lib/publicJudgingPage";
import { checkRateLimitById, getClientIpFromHeaders } from "@/lib/rateLimit";

/**
 * Published finalists, as the public results page shows them: titles,
 * entrant display names and links per round, never scores or ranks. The
 * event page's visibility rules apply first, and nothing published yet is
 * NOT_FOUND like a hidden event. Rate limited per address like search.
 */
export const GET = mobileRoute<{ orgSlug: string; eventSlug: string }>("GET /api/mobile/v1/public/events/:orgSlug/:eventSlug/finalists", async (request, { orgSlug, eventSlug }) => {
  if (!(await checkRateLimitById("search", getClientIpFromHeaders(request.headers)))) return mobileError("RATE_LIMITED");
  const resolved = await resolvePublicJudgingEvent(orgSlug, eventSlug);
  if (!resolved) return notFound();
  const rounds = await loadPublicFinalists(resolved.event.id);
  if (rounds.length === 0) return notFound();
  return mobileOk(publicFinalistsDtoSchema.parse({
    rounds: rounds.map((round) => ({
      roundName: round.roundName,
      publishedAt: round.publishedAt.toISOString(),
      finalists: round.finalists.map((finalist) => ({
        title: finalist.title, entrantName: finalist.entrantName, isTeam: finalist.isTeam,
        links: { repo: finalist.repoUrl, demo: finalist.demoUrl, video: finalist.videoUrl },
      })),
    })),
  }));
}, { optionalAuth: true });
