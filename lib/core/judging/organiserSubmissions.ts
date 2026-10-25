import "server-only";

/** Organiser read models for Judging → Submissions: the paged list and one project's reviews. */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { escapeLikePattern } from "@/lib/core/teams";
import { decodeTimeCursor, encodeTimeCursor } from "@/lib/keysetCursor";
import { ORGANISER_SUBMISSIONS_PAGE_SIZE, organiserSubmissionsQuerySchema } from "@/lib/judgingOrganiserPaging";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { organiserSubmissionDto, type OrganiserSubmissionDto } from "@/lib/judgingDto";
import { isId, JUDGING_EXPORT_BATCH_SIZE, projectSelect } from "./shared";

// ---------------------------------------------------------------------------
// Organiser read models
// ---------------------------------------------------------------------------

export type OrganiserSubmissionsPage = { submissions: OrganiserSubmissionDto[]; nextCursor: string | null };

/**
 * Judging → Submissions, one bounded page at a time (oldest first, keyset
 * paging on `createdAt, id`), with status, organiser-only reason, and
 * assigned judges. The status filter and the search (project title, or the
 * entrant's name: the team name, else the registrant's name) run in SQL,
 * within this event of this organisation only. Per-status totals come from
 * `loadJudgingSetup().counts`.
 */
export async function listSubmissionsForOrganiser(
  ctx: JudgingOrganiserContext,
  input: unknown = {},
  options: { pageSize?: number } = {},
): Promise<OrganiserSubmissionsPage> {
  // The dashboard pages 50 at a time; the Submissions CSV reads larger,
  // still bounded, batches through the same query.
  const pageSize = Math.min(Math.max(1, Math.floor(options.pageSize ?? ORGANISER_SUBMISSIONS_PAGE_SIZE)), JUDGING_EXPORT_BATCH_SIZE);
  const empty: OrganiserSubmissionsPage = { submissions: [], nextCursor: null };
  const parsed = organiserSubmissionsQuerySchema.safeParse(input);
  if (!parsed.success) return empty;
  const { query, status, cursor } = parsed.data;
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: { id: true } });
  if (!event) return empty;

  const conditions: Prisma.Sql[] = [Prisma.sql`s."eventId" = ${event.id}`];
  if (status !== "all") conditions.push(Prisma.sql`s."status" = ${status}::"SubmissionStatus"`);
  if (query) {
    const pattern = `%${escapeLikePattern(query)}%`;
    conditions.push(Prisma.sql`(
      s."title" ILIKE ${pattern}
      OR COALESCE(t."name", NULLIF(btrim(u."name"), ''), NULLIF(btrim(r."guestName"), ''), '') ILIKE ${pattern}
    )`);
  }
  if (cursor) {
    const after = decodeTimeCursor(cursor);
    if (!after) return empty;
    // `createdAt` is a UTC wall-clock timestamp(3) column.
    const at = after.at.toISOString().replace("Z", "");
    conditions.push(Prisma.sql`(s."createdAt", s."id") > (${at}::timestamp(3), ${after.id})`);
  }
  const ids = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s."id" FROM "Submission" s
    LEFT JOIN "Team" t ON t."id" = s."teamId"
    LEFT JOIN "RSVP" r ON r."id" = s."rsvpId"
    LEFT JOIN "User" u ON u."id" = r."userId"
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY s."createdAt" ASC, s."id" ASC
    LIMIT ${pageSize + 1}`;
  const pageIds = ids.slice(0, pageSize).map((row) => row.id);
  if (pageIds.length === 0) return empty;

  const rows = await prisma.submission.findMany({
    where: { id: { in: pageIds }, eventId: event.id },
    select: {
      ...projectSelect,
      status: true,
      createdAt: true,
      submittedAt: true,
      updatedAt: true,
      disqualifiedReason: true,
      assignments: { select: { judgeUserId: true }, orderBy: [{ createdAt: "asc" }, { judgeUserId: "asc" }] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const last = rows[rows.length - 1];
  return {
    submissions: rows.map((row) => organiserSubmissionDto(row, row.assignments.map((assignment) => assignment.judgeUserId))),
    nextCursor: ids.length > pageSize && last ? encodeTimeCursor({ at: last.createdAt, id: last.id }) : null,
  };
}

export type OrganiserReviewDto = {
  judgeName: string;
  submittedAt: Date | null;
  comment: string;
  scores: Array<{ criterionId: string; score: number }>;
};

/** Judges' reviews of one submission, with private comments. Organisers only. */
export async function loadSubmissionReviewsForOrganiser(ctx: JudgingOrganiserContext, submissionId: string): Promise<OrganiserReviewDto[] | null> {
  if (!isId(submissionId)) return null;
  const submission = await prisma.submission.findFirst({
    where: { id: submissionId, eventId: ctx.eventId, event: { organisationId: ctx.organisationId } },
    select: {
      reviews: { select: { judgeUserId: true, comment: true, submittedAt: true, judge: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
      scores: { select: { judgeUserId: true, criterionId: true, score: true } },
    },
  });
  if (!submission) return null;
  return submission.reviews.map((review) => ({
    judgeName: review.judge.name?.trim() || "Judge",
    submittedAt: review.submittedAt,
    comment: review.comment,
    scores: submission.scores.filter((score) => score.judgeUserId === review.judgeUserId).map((score) => ({ criterionId: score.criterionId, score: score.score })),
  }));
}
