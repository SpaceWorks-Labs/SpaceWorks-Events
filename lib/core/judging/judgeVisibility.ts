import "server-only";

/** Which submissions a judge may see, in Prisma and in SQL, and the judge list's progress filters. */

import { Prisma, SubmissionStatus } from "@prisma/client";
import type { JudgeSubmissionFilter } from "@/lib/judgingPaging";
import { type ConflictKeys, conflictKeysFor, hasConflictOfInterest } from "./judges";

/** Submissions this judge may see: SUBMITTED, assigned (unless judgesSeeAll), and no conflict of interest. */
export async function visibleSubmissionIds(client: Prisma.TransactionClient, event: { id: string; judgesSeeAll: boolean }, judgeUserId: string, onlyId?: string) {
  const rows = await client.submission.findMany({
    where: {
      eventId: event.id,
      status: SubmissionStatus.SUBMITTED,
      ...(onlyId ? { id: onlyId } : {}),
      ...(event.judgesSeeAll ? {} : { assignments: { some: { judgeUserId } } }),
    },
    select: { id: true, teamId: true, rsvpId: true },
  });
  const conflicts = (await conflictKeysFor(client, event.id, [judgeUserId])).get(judgeUserId);
  return rows.filter((row) => !hasConflictOfInterest(row, conflicts)).map((row) => row.id);
}

/**
 * SQL conditions (on `"Submission" s`) for the submissions this judge may see,
 * the same rule as visibleSubmissionIds: SUBMITTED, in this event, assigned
 * unless judgesSeeAll, and not an entrant the judge's own account belongs to.
 */
export function judgeVisibleSql(event: { id: string; judgesSeeAll: boolean }, judgeUserId: string, conflicts: ConflictKeys | undefined): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`s."eventId" = ${event.id}`,
    Prisma.sql`s."status" = ${SubmissionStatus.SUBMITTED}::"SubmissionStatus"`,
  ];
  if (!event.judgesSeeAll) {
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "JudgeAssignment" ja WHERE ja."submissionId" = s."id" AND ja."judgeUserId" = ${judgeUserId})`);
  }
  const teamIds = [...(conflicts?.teamIds ?? [])];
  const rsvpIds = [...(conflicts?.rsvpIds ?? [])];
  if (teamIds.length) conditions.push(Prisma.sql`(s."teamId" IS NULL OR s."teamId" NOT IN (${Prisma.join(teamIds)}))`);
  if (rsvpIds.length) conditions.push(Prisma.sql`(s."rsvpId" IS NULL OR s."rsvpId" NOT IN (${Prisma.join(rsvpIds)}))`);
  return conditions;
}

export function reviewedBySql(judgeUserId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "JudgeReview" jr WHERE jr."submissionId" = s."id" AND jr."judgeUserId" = ${judgeUserId} AND jr."submittedAt" IS NOT NULL)`;
}

export function scoredBySql(judgeUserId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "JudgeScore" js WHERE js."submissionId" = s."id" AND js."judgeUserId" = ${judgeUserId})`;
}

export function judgeFilterSql(filter: JudgeSubmissionFilter, judgeUserId: string): Prisma.Sql | null {
  if (filter === "reviewed") return reviewedBySql(judgeUserId);
  if (filter === "todo") return Prisma.sql`NOT ${reviewedBySql(judgeUserId)}`;
  if (filter === "in_progress") return Prisma.sql`(NOT ${reviewedBySql(judgeUserId)} AND ${scoredBySql(judgeUserId)})`;
  return null;
}
