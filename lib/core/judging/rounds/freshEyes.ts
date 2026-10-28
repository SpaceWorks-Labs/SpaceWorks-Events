import "server-only";

/**
 * "Fresh eyes" (docs/HACKATHON.md "Rounds"): when a round has it on, a judge
 * neither sees nor is assigned a project they submitted a review for in an
 * earlier round of the same event. A hard rule, applied with conflicts of
 * interest everywhere a round's judge/project pairs are decided.
 */

import { Prisma } from "@prisma/client";
import { pairKey } from "@/lib/judgingAssignment";
import type { JudgingRoundScope } from "./scope";

type FreshEyesRound = Pick<JudgingRoundScope, "eventId" | "position" | "freshEyes">;

/** `pairKey(judge, project)` of every earlier-round submitted review, when the round has fresh eyes on (else empty). */
export async function freshEyesBlockedPairs(client: Prisma.TransactionClient, round: FreshEyesRound): Promise<Set<string>> {
  if (!round.freshEyes) return new Set();
  const rows = await client.judgeReview.findMany({
    where: { submittedAt: { not: null }, round: { eventId: round.eventId, position: { lt: round.position } } },
    select: { judgeUserId: true, submissionId: true },
  });
  return new Set(rows.map((row) => pairKey(row.judgeUserId, row.submissionId)));
}

/** Prisma condition on a Submission: not reviewed by this judge in an earlier round (when fresh eyes is on). */
export function freshEyesWhere(round: FreshEyesRound, judgeUserId: string): Prisma.SubmissionWhereInput {
  if (!round.freshEyes) return {};
  return { NOT: { reviews: { some: { judgeUserId, submittedAt: { not: null }, round: { eventId: round.eventId, position: { lt: round.position } } } } } };
}

/** The same rule in SQL, on `"Submission" s`; null when fresh eyes is off. */
export function freshEyesSql(round: FreshEyesRound, judgeUserId: string): Prisma.Sql | null {
  if (!round.freshEyes) return null;
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "JudgeReview" fe JOIN "JudgingRound" fr ON fr."id" = fe."roundId"
    WHERE fe."submissionId" = s."id" AND fe."judgeUserId" = ${judgeUserId} AND fe."submittedAt" IS NOT NULL
      AND fr."eventId" = ${round.eventId} AND fr."position" < ${round.position}
  )`;
}
