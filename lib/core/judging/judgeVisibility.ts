import "server-only";

/** Which submissions a judge may see in a round, in Prisma and in SQL, and the judge list's progress filters. */

import { Prisma } from "@prisma/client";
import type { JudgeSubmissionFilter } from "@/lib/judgingPaging";
import { type ConflictKeys, conflictKeysFor, hasConflictOfInterest } from "./judges";
import { type JudgingRoundScope, onRoundPanel, roundProjectsSql, roundProjectsWhere, roundScoreSql } from "./rounds/scope";
import { freshEyesSql, freshEyesWhere } from "./rounds/freshEyes";

type VisibilityRound = Pick<JudgingRoundScope, "id" | "eventId" | "entrySource" | "judgesSeeAll" | "panelUserIds" | "position" | "freshEyes">;

/**
 * Submissions this judge may see in a round: the round's projects (SUBMITTED;
 * advanced into it for an ADVANCED round), assigned in that round unless
 * judgesSeeAll, on the round's panel when it has one, not reviewed by
 * this judge in an earlier round when the round has fresh eyes on, and no
 * conflict of interest.
 */
export async function visibleSubmissionIds(client: Prisma.TransactionClient, round: VisibilityRound, judgeUserId: string, onlyId?: string) {
  if (!onRoundPanel(round, judgeUserId)) return [];
  const rows = await client.submission.findMany({
    where: {
      ...roundProjectsWhere(round),
      ...(onlyId ? { id: onlyId } : {}),
      ...(round.judgesSeeAll ? {} : { assignments: { some: { judgeUserId, roundId: round.id } } }),
      ...freshEyesWhere(round, judgeUserId),
    },
    select: { id: true, teamId: true, rsvpId: true },
  });
  const conflicts = (await conflictKeysFor(client, round.eventId, [judgeUserId])).get(judgeUserId);
  return rows.filter((row) => !hasConflictOfInterest(row, conflicts)).map((row) => row.id);
}

/**
 * SQL conditions (on `"Submission" s`) for the submissions this judge may see,
 * the same rule as visibleSubmissionIds.
 */
export function judgeVisibleSql(round: VisibilityRound, judgeUserId: string, conflicts: ConflictKeys | undefined): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = roundProjectsSql(round);
  if (!onRoundPanel(round, judgeUserId)) conditions.push(Prisma.sql`FALSE`);
  if (!round.judgesSeeAll) {
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "JudgeAssignment" ja WHERE ja."submissionId" = s."id" AND ja."judgeUserId" = ${judgeUserId} AND ja."roundId" = ${round.id})`);
  }
  const freshEyes = freshEyesSql(round, judgeUserId);
  if (freshEyes) conditions.push(freshEyes);
  const teamIds = [...(conflicts?.teamIds ?? [])];
  const rsvpIds = [...(conflicts?.rsvpIds ?? [])];
  if (teamIds.length) conditions.push(Prisma.sql`(s."teamId" IS NULL OR s."teamId" NOT IN (${Prisma.join(teamIds)}))`);
  if (rsvpIds.length) conditions.push(Prisma.sql`(s."rsvpId" IS NULL OR s."rsvpId" NOT IN (${Prisma.join(rsvpIds)}))`);
  return conditions;
}

export function reviewedBySql(round: Pick<JudgingRoundScope, "id">, judgeUserId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "JudgeReview" jr WHERE jr."submissionId" = s."id" AND jr."judgeUserId" = ${judgeUserId} AND jr."roundId" = ${round.id} AND jr."submittedAt" IS NOT NULL)`;
}

export function scoredBySql(round: Pick<JudgingRoundScope, "id">, judgeUserId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "JudgeScore" js WHERE js."submissionId" = s."id" AND js."judgeUserId" = ${judgeUserId} AND ${roundScoreSql(round)})`;
}

export function judgeFilterSql(filter: JudgeSubmissionFilter, round: Pick<JudgingRoundScope, "id">, judgeUserId: string): Prisma.Sql | null {
  if (filter === "reviewed") return reviewedBySql(round, judgeUserId);
  if (filter === "todo") return Prisma.sql`NOT ${reviewedBySql(round, judgeUserId)}`;
  if (filter === "in_progress") return Prisma.sql`(NOT ${reviewedBySql(round, judgeUserId)} AND ${scoredBySql(round, judgeUserId)})`;
  return null;
}
