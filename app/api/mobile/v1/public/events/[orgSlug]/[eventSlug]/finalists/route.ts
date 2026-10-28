import { loadPublicFinalists } from "@/lib/core/judgingRounds";
import { mobileOk, notFound } from "@/lib/mobile/http";
import { mobileRoute } from "@/lib/mobile/route";
import { publicFinalistsDtoSchema } from "@/lib/mobile/schemas";
import { resolvePublicJudgingEvent } from "@/lib/publicJudgingPage";

/**
 * Published finalists, as the public results page shows them: titles,
 * entrant display names and links per round, never scores or ranks. The
 * event page's visibility rules apply first.
 */
export const GET = mobileRoute<{ orgSlug: string; eventSlug: string }>("GET /api/mobile/v1/public/events/:orgSlug/:eventSlug/finalists", async (_request, { orgSlug, eventSlug }) => {
  const resolved = await resolvePublicJudgingEvent(orgSlug, eventSlug);
  if (!resolved) return notFound();
  const rounds = await loadPublicFinalists(resolved.event.id);
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
