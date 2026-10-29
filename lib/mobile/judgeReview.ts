import "server-only";

import { prisma } from "@/lib/db";
import type { JudgeContext } from "@/lib/judgingAccess";
import { resolveJudgingRound } from "@/lib/core/judging/rounds/scope";
import { ROUND_CHANGED } from "@/lib/core/judging/judgeScoring";
import { mobileError } from "@/lib/mobile/http";

/**
 * Pin the round a scoring write acts on, once per request: the current round
 * (null before the event has any). `?roundId=` naming any other round answers
 * JUDGING_CLOSED, because judges write only to the round they score now. Every
 * write of the request passes the pinned round to the core, which compares it
 * after the Event lock (lib/core/judging/judgeScoring.ts), so a round switched
 * mid-request is refused rather than written to.
 */
export async function pinScoringRound(judge: JudgeContext, roundId: string | null): Promise<{ roundId: string | null } | { response: Response }> {
  const event = await prisma.event.findFirst({
    where: { id: judge.eventId, organisationId: judge.organisationId },
    select: { id: true, judgingStatus: true, judgesSeeAll: true, reviewsPerProject: true, scoreNormalization: true },
  });
  const current = event ? await resolveJudgingRound(prisma, event) : null;
  if (roundId && current?.id !== roundId) return { response: mobileError("JUDGING_CLOSED", ROUND_CHANGED) };
  return { roundId: current?.id ?? null };
}

/** This judge's review of a project in the request's pinned round, or null when there is none yet. */
export async function pinnedRoundReview(judge: JudgeContext, roundId: string | null, submissionId: string) {
  if (!roundId) return null;
  return prisma.judgeReview.findUnique({
    where: { roundId_submissionId_judgeUserId: { roundId, submissionId, judgeUserId: judge.userId } },
    select: { comment: true, submittedAt: true },
  });
}
