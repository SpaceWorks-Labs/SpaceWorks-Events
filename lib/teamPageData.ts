import "server-only";

import { prisma } from "@/lib/db";
import { listSeekersForLeader, loadTeamPage, type TeamLeaderAuth } from "@/lib/core/teams";

/**
 * Data for the leader's team page, reached by management token or by a
 * signed-in leader. Callers resolve `auth` first; this re-checks it while
 * loading and returns null on any mismatch so a stale or foreign link reveals nothing.
 */
export async function loadTeamPageData(auth: TeamLeaderAuth) {
  const [page, seekers, accent] = await Promise.all([
    loadTeamPage(auth),
    listSeekersForLeader(auth),
    prisma.event.findUnique({ where: { id: auth.eventId }, select: { page: { select: { accentColor: true } } } }),
  ]);
  if (!page) return null;
  return { page, seekers, accentColor: accent?.page?.accentColor ?? null };
}

export type TeamPageData = NonNullable<Awaited<ReturnType<typeof loadTeamPageData>>>;
