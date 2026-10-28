import "server-only";

import { prisma } from "@/lib/db";
import type { JudgeContext } from "@/lib/judgingAccess";
import { resolveJudgingRound } from "@/lib/core/judging/rounds/scope";
import { mobileError } from "@/lib/mobile/http";

/**
 * `?roundId=` on a scoring write: absent or the current round goes ahead;
 * any other round answers JUDGING_CLOSED, because judges write only to the
 * round they score now (lib/core/judging/judgeScoring.ts).
 */
export async function refuseUnlessCurrentRound(judge: JudgeContext, roundId: string | null) {
  if (!roundId) return null;
  const event = await prisma.event.findFirst({
    where: { id: judge.eventId, organisationId: judge.organisationId },
    select: { id: true, judgingStatus: true, judgesSeeAll: true, reviewsPerProject: true, scoreNormalization: true },
  });
  const current = event ? await resolveJudgingRound(prisma, event) : null;
  return current?.id === roundId ? null : mobileError("JUDGING_CLOSED", "Scores are saved to the current round only.");
}

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
