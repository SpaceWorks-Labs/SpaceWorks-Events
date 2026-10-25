import "server-only";

/** Public read models: published results and the project gallery. */

import { Prisma, SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { clampPage, parseGalleryFilterParam, parseGallerySortParam, parseSearchParam, PROJECT_GALLERY_PAGE_SIZE, totalPagesFor } from "@/lib/judgingPaging";
import { matchesProjectQuery } from "@/lib/judgingOrganiserPaging";
import { galleryFromSql, galleryOrderSql, galleryWhereSql } from "@/lib/galleryQuery";
import { publicGalleryItemDto, publicWinnerDto, type PublicAwardBadgeDto, type PublicGalleryDto, type PublicResultsDto } from "@/lib/judgingDto";
import { EVENT_AWARD_PLACE_MAX, EVENT_AWARDS_LIMIT } from "@/lib/validators";
import { isId, isProjectGalleryVisible, nameSourceSelect, projectSelect } from "./shared";

// ---------------------------------------------------------------------------
// Public read models (callers apply the event page's visibility rules first)
// ---------------------------------------------------------------------------

/**
 * Published results for `/{org}/{event}/results`: awards and SUBMITTED
 * winners only, never scores or comments. Null (render a 404) unless results
 * are published. The caller must already have applied the event page's
 * publication, visibility, and invite rules for this viewer.
 *
 * `query` (trimmed and bounded like the gallery's `?q=`) narrows the winners
 * to those whose project title or shown entrant name contains it; awards
 * left without a match are dropped. The list is bounded by the award limits,
 * so the match runs over the loaded DTOs, on exactly the text shown.
 */
export async function loadPublicResults(eventId: string, options: { query?: string } = {}): Promise<PublicResultsDto | null> {
  if (!isId(eventId)) return null;
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      submissionsEnabled: true,
      resultsPublishedAt: true,
      // Defensive bounds for a public page. They never cut a valid event:
      // award creation stops at EVENT_AWARDS_LIMIT, and each award has at
      // most one winner per place in 1..EVENT_AWARD_PLACE_MAX.
      awards: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: EVENT_AWARDS_LIMIT,
        select: {
          name: true,
          description: true,
          winners: {
            where: { submission: { status: SubmissionStatus.SUBMITTED } },
            orderBy: [{ place: "asc" }, { id: "asc" }],
            take: EVENT_AWARD_PLACE_MAX,
            select: { place: true, submission: { select: { title: true, repoUrl: true, demoUrl: true, videoUrl: true, ...nameSourceSelect } } },
          },
        },
      },
    },
  });
  if (!event?.submissionsEnabled || !event.resultsPublishedAt) return null;
  const query = parseSearchParam(options.query);
  const awards = event.awards.map((award, index) => ({ name: award.name, description: award.description, isTop: index === 0, winners: award.winners.map(publicWinnerDto) }));
  const totalWinners = awards.reduce((sum, award) => sum + award.winners.length, 0);
  if (!query) return { publishedAt: event.resultsPublishedAt, awards, query, totalWinners, matchedWinners: totalWinners };
  const matching = awards
    .map((award) => ({ ...award, winners: award.winners.filter((winner) => matchesProjectQuery(winner, query)) }))
    .filter((award) => award.winners.length > 0);
  return {
    publishedAt: event.resultsPublishedAt,
    awards: matching,
    query,
    totalWinners,
    matchedWinners: matching.reduce((sum, award) => sum + award.winners.length, 0),
  };
}

/** Raw gallery URL values; anything invalid or not yet allowed falls back to the default. */
export type ProjectGalleryQuery = { page?: number; query?: string; filter?: string; sort?: string };

/**
 * One page of submitted projects for `/{org}/{event}/projects`, once the
 * window has closed and the organiser made the gallery public. Null (render a
 * 404) otherwise, before any project is read. The page is clamped to the
 * pages that exist. The caller must already have applied the event page's
 * visibility rules.
 *
 * Search, the *Award winners* filter, and the order (`newest`, `az`,
 * `awards`; lib/galleryQuery.ts) all run in SQL. The filter, the awards
 * order, and award badges exist only once results are published; before
 * that they fall back to all projects, newest first, and no badges, so the
 * gallery never reveals a winner early.
 */
export async function loadProjectGallery(eventId: string, now: Date = new Date(), options: ProjectGalleryQuery = {}): Promise<PublicGalleryDto | null> {
  if (!isId(eventId)) return null;
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { submissionsEnabled: true, projectGalleryPublic: true, submissionsCloseAt: true, resultsPublishedAt: true },
  });
  if (!event || !isProjectGalleryVisible(event, now)) return null;
  const resultsPublished = event.resultsPublishedAt != null;
  const query = parseSearchParam(options.query);
  const filter = parseGalleryFilterParam(options.filter, resultsPublished);
  const sort = parseGallerySortParam(options.sort, resultsPublished);
  const narrowed = query !== "" || filter !== "all";
  const where = galleryWhereSql(eventId, { query, filter });
  const countWhere = (sql: Prisma.Sql) => prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS "count" FROM "Submission" s WHERE ${sql}`.then((rows) => Number(rows[0]?.count ?? 0));
  const [total, matched, winners] = await Promise.all([
    prisma.submission.count({ where: { eventId, status: SubmissionStatus.SUBMITTED } }),
    narrowed ? countWhere(where) : null,
    resultsPublished ? countWhere(galleryWhereSql(eventId, { query: "", filter: "winners" })) : 0,
  ]);
  const matchedCount = matched ?? total;
  const pageSize = PROJECT_GALLERY_PAGE_SIZE;
  const totalPages = totalPagesFor(matchedCount, pageSize);
  const page = clampPage(options.page ?? 1, totalPages);
  const result = { total, matched: matchedCount, winners, query, filter, sort, resultsPublished, page, totalPages, pageSize };
  if (matchedCount === 0) return { projects: [], ...result };
  const ids = (
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT s."id" FROM ${galleryFromSql(sort)}
      WHERE ${where}
      ORDER BY ${galleryOrderSql(sort)}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
  ).map((row) => row.id);
  if (ids.length === 0) return { projects: [], ...result };
  const [rows, badges] = await Promise.all([
    prisma.submission.findMany({ where: { id: { in: ids }, eventId, status: SubmissionStatus.SUBMITTED }, select: projectSelect }),
    resultsPublished
      ? prisma.eventAwardWinner.findMany({
          where: { submissionId: { in: ids }, award: { eventId } },
          orderBy: [{ award: { position: "asc" } }, { award: { createdAt: "asc" } }, { award: { id: "asc" } }, { place: "asc" }],
          select: { submissionId: true, place: true, award: { select: { name: true } } },
        })
      : [],
  ]);
  const badgesBySubmission = new Map<string, PublicAwardBadgeDto[]>();
  for (const badge of badges) {
    const list = badgesBySubmission.get(badge.submissionId) ?? [];
    list.push({ name: badge.award.name, place: badge.place });
    badgesBySubmission.set(badge.submissionId, list);
  }
  // Keep the SQL order; the row fetch above is unordered.
  const byId = new Map(rows.map((row) => [row.id, row]));
  const projects = ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [publicGalleryItemDto(row, badgesBySubmission.get(id) ?? [])] : [];
  });
  return { projects, ...result };
}
