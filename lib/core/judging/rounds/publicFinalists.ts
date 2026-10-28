import "server-only";

/** Published finalists for the public results page (docs/HACKATHON.md "Rounds"). */

import { SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { publicWinnerDto, type PublicWinnerDto } from "@/lib/judgingDto";
import { FINALISTS_LIMIT } from "@/lib/validators/judgingRounds";
import { isId, nameSourceSelect } from "../shared";

export type PublicFinalistsDto = { roundName: string; publishedAt: Date; finalists: Array<Omit<PublicWinnerDto, "place">> };

/**
 * One block per round whose finalists are published, in round order:
 * SUBMITTED projects only, titles, entrant display names and links (never
 * scores or ranks), alphabetical. The caller applies the event page's
 * visibility rules first.
 */
export async function loadPublicFinalists(eventId: string): Promise<PublicFinalistsDto[]> {
  if (!isId(eventId)) return [];
  const rounds = await prisma.judgingRound.findMany({
    where: { eventId, finalistsPublishedAt: { not: null }, event: { submissionsEnabled: true } },
    orderBy: { position: "asc" },
    select: {
      name: true,
      finalistsPublishedAt: true,
      entries: {
        where: { submission: { eventId, status: SubmissionStatus.SUBMITTED } },
        orderBy: [{ submission: { title: "asc" } }, { submissionId: "asc" }],
        take: FINALISTS_LIMIT,
        select: { submission: { select: { title: true, repoUrl: true, demoUrl: true, videoUrl: true, ...nameSourceSelect } } },
      },
    },
  });
  return rounds
    .filter((round) => round.entries.length > 0)
    .map((round) => ({
      roundName: round.name,
      publishedAt: round.finalistsPublishedAt!,
      finalists: round.entries.map((entry) => {
        const { place: _place, ...rest } = publicWinnerDto({ place: 1, submission: entry.submission });
        void _place;
        return rest;
      }),
    }));
}
