import "server-only";

import { prisma } from "@/lib/db";
import type { JudgeContext } from "@/lib/judgingAccess";
import { resolveJudgingRound } from "@/lib/core/judging/rounds/scope";

/**
 * This judge's review of a project in the event's current judging round (the
 * round the mobile judging routes act on), or null when there is none yet.
 */
export async function currentRoundReview(judge: JudgeContext, submissionId: string) {
  const event = await prisma.event.findFirst({
    where: { id: judge.eventId, organisationId: judge.organisationId },
    select: { id: true, judgingStatus: true, judgesSeeAll: true, reviewsPerProject: true, scoreNormalization: true },
  });
  if (!event) return null;
  const round = await resolveJudgingRound(prisma, event);
  if (!round?.id) return null;
  return prisma.judgeReview.findUnique({
    where: { roundId_submissionId_judgeUserId: { roundId: round.id, submissionId, judgeUserId: judge.userId } },
    select: { comment: true, submittedAt: true },
  });
}
