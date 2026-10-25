import "server-only";

import { Prisma, RsvpStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { decodeKeyCursor, encodeKeyCursor } from "@/lib/keysetCursor";
import { ORGANISER_TEAM_FILTERS, type OrganiserTeamFilter } from "@/lib/organiserTeamFilters";
import { personEmail, personName, type OrganiserEventContext } from "./shared";
import { decodeTeamCursor, encodeTeamCursor, escapeLikePattern, sqlTimestamp } from "./paging";

export type OrganiserTeamDto = {
  id: string;
  name: string;
  status: RsvpStatus;
  size: number;
  minSize: number | null;
  maxSize: number | null;
  incomplete: boolean;
  lookingForMembers: boolean;
  createdAt: Date;
  leaderRsvpId: string | null;
  members: Array<{ rsvpId: string; name: string; email: string | null; isLeader: boolean; checkedIn: boolean }>;
};

/** Teams per page in the organiser's Teams view; "Load more" fetches the next page. */
export const ORGANISER_TEAMS_PAGE_SIZE = 50;
/** Teams per batch when the Teams CSV streams a filtered view (the largest page the query serves). */
export const ORGANISER_TEAMS_EXPORT_BATCH_SIZE = 200;
/** Teams per page in the Move to team picker; "Show more" fetches the next page. */
export const TEAM_MOVE_TARGETS_PAGE_SIZE = 20;

export { ORGANISER_TEAM_FILTERS, type OrganiserTeamFilter } from "@/lib/organiserTeamFilters";

const FILTER_STATUS: Partial<Record<OrganiserTeamFilter, RsvpStatus>> = {
  going: RsvpStatus.CONFIRMED,
  waitlist: RsvpStatus.WAITLISTED,
  approve: RsvpStatus.PENDING_APPROVAL,
  declined: RsvpStatus.REJECTED,
};


export const organiserTeamsQuerySchema = z
  .object({
    query: z.string().trim().max(100).optional().default(""),
    filter: z.enum(ORGANISER_TEAM_FILTERS).optional().default("all"),
    cursor: z.string().trim().max(160).nullable().optional(),
  })
  .strict();

export type OrganiserTeamsPage = { teams: OrganiserTeamDto[]; nextCursor: string | null };

/**
 * Guests tab → Teams view, one bounded page at a time (oldest first, keyset
 * paging on `createdAt, id`). Searches team names, and members' names and
 * emails, within this event only. Callers must have passed
 * `resolveOrganiserEvent`.
 */
export async function listEventTeamsForOrganiser(
  ctx: OrganiserEventContext,
  input: unknown = {},
  options: { pageSize?: number } = {},
): Promise<OrganiserTeamsPage> {
  // The dashboard pages 50 at a time; the filtered Teams CSV reads larger,
  // still bounded, batches through the same query.
  const pageSize = Math.min(Math.max(1, Math.floor(options.pageSize ?? ORGANISER_TEAMS_PAGE_SIZE)), ORGANISER_TEAMS_EXPORT_BATCH_SIZE);
  const empty: OrganiserTeamsPage = { teams: [], nextCursor: null };
  const parsed = organiserTeamsQuerySchema.safeParse(input);
  if (!parsed.success) return empty;
  const { query, filter, cursor } = parsed.data;
  const event = await prisma.event.findFirst({
    where: { id: ctx.eventId, organisationId: ctx.organisationId },
    select: { id: true, teamMinSize: true, teamMaxSize: true },
  });
  if (!event) return empty;

  const conditions: Prisma.Sql[] = [Prisma.sql`t."eventId" = ${event.id}`];
  const status = FILTER_STATUS[filter];
  if (status) conditions.push(Prisma.sql`t."status" = ${status}::"RsvpStatus"`);
  if (filter === "incomplete") {
    if (event.teamMinSize == null) return empty;
    conditions.push(Prisma.sql`(SELECT count(*) FROM "RSVP" r WHERE r."teamId" = t."id") < ${event.teamMinSize}`);
  }
  if (filter === "looking") conditions.push(Prisma.sql`t."lookingForMembers" = true`);
  if (query) {
    const pattern = `%${escapeLikePattern(query)}%`;
    conditions.push(Prisma.sql`(
      t."name" ILIKE ${pattern}
      OR EXISTS (
        SELECT 1 FROM "RSVP" r LEFT JOIN "User" u ON u."id" = r."userId"
        WHERE r."teamId" = t."id" AND r."eventId" = ${event.id}
          AND (r."guestName" ILIKE ${pattern} OR r."guestEmail" ILIKE ${pattern} OR u."name" ILIKE ${pattern} OR u."email" ILIKE ${pattern})
      )
    )`);
  }
  if (cursor) {
    const after = decodeTeamCursor(cursor);
    if (!after) return empty;
    const at = sqlTimestamp(after.createdAt);
    conditions.push(Prisma.sql`(t."createdAt", t."id") > (${at}::timestamp(3), ${after.id})`);
  }
  const ids = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT t."id" FROM "Team" t
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY t."createdAt" ASC, t."id" ASC
    LIMIT ${pageSize + 1}`;
  const pageIds = ids.slice(0, pageSize).map((row) => row.id);
  if (pageIds.length === 0) return empty;

  const rows = await prisma.team.findMany({
    where: { id: { in: pageIds }, eventId: event.id },
    select: {
      id: true,
      name: true,
      status: true,
      lookingForMembers: true,
      createdAt: true,
      leaderRsvpId: true,
      members: {
        select: { id: true, guestName: true, guestEmail: true, checkedInAt: true, user: { select: { name: true, email: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const teams = rows.map((team) => ({
    id: team.id,
    name: team.name,
    status: team.status,
    size: team.members.length,
    minSize: event.teamMinSize,
    maxSize: event.teamMaxSize,
    incomplete: event.teamMinSize != null && team.members.length < event.teamMinSize,
    lookingForMembers: team.lookingForMembers,
    createdAt: team.createdAt,
    leaderRsvpId: team.leaderRsvpId,
    members: team.members.map((member) => ({
      rsvpId: member.id,
      name: personName(member),
      email: personEmail(member),
      isLeader: member.id === team.leaderRsvpId,
      checkedIn: member.checkedInAt != null,
    })),
  }));
  const last = rows[rows.length - 1];
  return { teams, nextCursor: ids.length > pageSize && last ? encodeTeamCursor(last) : null };
}

/** How many of the event's teams each Teams-view filter holds (aggregates only). */
export async function countEventTeamsForOrganiser(ctx: OrganiserEventContext): Promise<Record<OrganiserTeamFilter, number>> {
  const counts = Object.fromEntries(ORGANISER_TEAM_FILTERS.map((filter) => [filter, 0])) as Record<OrganiserTeamFilter, number>;
  const event = await prisma.event.findFirst({
    where: { id: ctx.eventId, organisationId: ctx.organisationId },
    select: { id: true, teamMinSize: true },
  });
  if (!event) return counts;
  const [groups, incomplete, looking] = await Promise.all([
    prisma.team.groupBy({ by: ["status"], where: { eventId: event.id }, _count: { _all: true } }),
    event.teamMinSize == null
      ? Promise.resolve([{ count: BigInt(0) }])
      : prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS "count" FROM "Team" t
          WHERE t."eventId" = ${event.id}
            AND (SELECT count(*) FROM "RSVP" r WHERE r."teamId" = t."id") < ${event.teamMinSize}`,
    prisma.team.count({ where: { eventId: event.id, lookingForMembers: true } }),
  ]);
  for (const group of groups) {
    counts.all += group._count._all;
    for (const [filter, status] of Object.entries(FILTER_STATUS) as Array<[OrganiserTeamFilter, RsvpStatus]>) {
      if (status === group.status) counts[filter] += group._count._all;
    }
  }
  counts.incomplete = Number(incomplete[0]?.count ?? 0);
  counts.looking = looking;
  return counts;
}

export const teamMoveTargetsQuerySchema = z
  .object({
    query: z.string().trim().max(100).optional().default(""),
    cursor: z.string().trim().max(600).nullable().optional(),
    /** The person's current team, never offered as a target. */
    excludeTeamId: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .strict();

export type TeamMoveTargetDto = { id: string; name: string; status: RsvpStatus; size: number; maxSize: number | null };
export type TeamMoveTargetsPage = { teams: TeamMoveTargetDto[]; nextCursor: string | null };

/**
 * Teams a registration could be moved into (People row "Move to team", and a
 * member move in the Teams view): this event's teams that are not declined
 * and, when the event caps team size, still have room. Alphabetical
 * (`nameKey, id` keyset), searched by name, one bounded page at a time, so
 * full teams never take up a page and every team can be reached. Names,
 * status and size only. The move itself re-checks everything under the
 * event lock. Callers must have passed `resolveOrganiserEvent`.
 */
export async function listTeamMoveTargetsForOrganiser(ctx: OrganiserEventContext, input: unknown = {}): Promise<TeamMoveTargetsPage> {
  const empty: TeamMoveTargetsPage = { teams: [], nextCursor: null };
  const parsed = teamMoveTargetsQuerySchema.safeParse(input ?? {});
  if (!parsed.success) return empty;
  const { query, cursor, excludeTeamId } = parsed.data;
  const event = await prisma.event.findFirst({
    where: { id: ctx.eventId, organisationId: ctx.organisationId },
    select: { id: true, teamMaxSize: true },
  });
  if (!event) return empty;

  const conditions: Prisma.Sql[] = [Prisma.sql`t."eventId" = ${event.id}`, Prisma.sql`t."status" <> ${RsvpStatus.REJECTED}::"RsvpStatus"`];
  if (event.teamMaxSize != null) {
    conditions.push(Prisma.sql`(SELECT count(*) FROM "RSVP" r WHERE r."teamId" = t."id") < ${event.teamMaxSize}`);
  }
  if (excludeTeamId) conditions.push(Prisma.sql`t."id" <> ${excludeTeamId}`);
  if (query) conditions.push(Prisma.sql`t."name" ILIKE ${`%${escapeLikePattern(query)}%`}`);
  if (cursor) {
    const after = decodeKeyCursor(cursor);
    if (!after) return empty;
    conditions.push(Prisma.sql`(t."nameKey", t."id") > (${after.key}, ${after.id})`);
  }
  const rows = await prisma.$queryRaw<Array<{ id: string; name: string; nameKey: string; status: RsvpStatus; size: bigint }>>`
    SELECT t."id", t."name", t."nameKey", t."status",
      (SELECT count(*) FROM "RSVP" r WHERE r."teamId" = t."id") AS "size"
    FROM "Team" t
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY t."nameKey" ASC, t."id" ASC
    LIMIT ${TEAM_MOVE_TARGETS_PAGE_SIZE + 1}`;
  const page = rows.slice(0, TEAM_MOVE_TARGETS_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    teams: page.map((team) => ({ id: team.id, name: team.name, status: team.status, size: Number(team.size), maxSize: event.teamMaxSize })),
    nextCursor: rows.length > TEAM_MOVE_TARGETS_PAGE_SIZE && last ? encodeKeyCursor({ key: last.nameKey, id: last.id }) : null,
  };
}
