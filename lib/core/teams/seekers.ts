import "server-only";

import { Prisma, RegistrationMode, RsvpStatus, TeamJoinRequestDirection, TeamJoinRequestStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isTeamTokenShape } from "@/lib/teamToken";
import { hasFreeSpace, isMatchingEvent, leaderAuthMatches, type TeamLeaderAuth, type TicketHolder } from "./shared";
import {
  decodeKeysetCursor,
  emptyPage,
  encodeKeysetCursor,
  escapeLikePattern,
  matchingListQuerySchema,
  sqlTimestamp,
  TEAM_MATCHING_PAGE_SIZE,
  type CursorPage,
} from "./paging";

// ---------------------------------------------------------------------------
// Read models (deliberately minimal DTOs)
// ---------------------------------------------------------------------------

/** Join page: never member names, emails, or tokens. */
export type JoinPageTeamDto = { name: string; size: number; maxSize: number | null };

export function joinPageTeamDto(team: { name: string; size: number }, maxSize: number | null): JoinPageTeamDto {
  return { name: team.name, size: team.size, maxSize };
}

/**
 * The team behind a join link, for an event the caller has already shown
 * under the event page's visibility and invite rules. Rejected teams and
 * other events' tokens return null.
 */
export async function loadJoinPageTeam(eventId: string, joinToken: string): Promise<JoinPageTeamDto | null> {
  if (!isTeamTokenShape(joinToken)) return null;
  const team = await prisma.team.findFirst({
    where: { joinToken, eventId, status: { not: RsvpStatus.REJECTED }, event: { registrationMode: RegistrationMode.TEAM } },
    select: { name: true, _count: { select: { members: true } }, event: { select: { teamMaxSize: true } } },
  });
  return team ? joinPageTeamDto({ name: team.name, size: team._count.members }, team.event.teamMaxSize) : null;
}

/** First name plus last initial ("Ada L."), never an email. */
export function seekerDisplayName(fullName: string | null | undefined): string {
  const parts = (fullName ?? "").replace(/[\u0000-\u001F\u007F<>]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Someone";
  const first = parts[0]!.slice(0, 40);
  if (parts.length === 1) return first;
  const initial = Array.from(parts[parts.length - 1]!)[0]!.toUpperCase();
  return `${first} ${initial}.`;
}

export type SeekerListItemDto = { id: string; displayName: string; headline: string; skills: string[] };

export function seekerListDto(rows: Array<{
  id: string;
  headline: string;
  skills: string[];
  rsvp: { guestName: string | null; user: { name: string | null } | null };
}>): SeekerListItemDto[] {
  return rows.map((row) => ({
    id: row.id,
    displayName: seekerDisplayName(row.rsvp.user?.name?.trim() || row.rsvp.guestName),
    headline: row.headline,
    skills: [...row.skills],
  }));
}

const seekerRowSelect = {
  id: true,
  headline: true,
  skills: true,
  rsvp: { select: { guestName: true, user: { select: { name: true } } } },
} satisfies Prisma.TeamSeekerProfileSelect;

type SeekerScope = { eventId: string; excludeRsvpId?: string; pendingWithTeamId?: string };

const SEEKER_FROM = Prisma.sql`"TeamSeekerProfile" s JOIN "RSVP" r ON r."id" = s."rsvpId" LEFT JOIN "User" u ON u."id" = r."userId"`;

/**
 * The visible seekers of one event: solo, not declined. A search matches the
 * headline, any skill, or the first name only: the list shows "Ada L.", so a
 * search must not reveal a surname. Emails are never matched.
 */
export function seekerListConditions(scope: SeekerScope, query: string): Prisma.Sql[] {
  const conditions = [
    Prisma.sql`s."visible" = true`,
    Prisma.sql`r."eventId" = ${scope.eventId}`,
    Prisma.sql`r."teamId" IS NULL`,
    Prisma.sql`r."status" <> ${RsvpStatus.REJECTED}::"RsvpStatus"`,
  ];
  if (scope.excludeRsvpId) conditions.push(Prisma.sql`r."id" <> ${scope.excludeRsvpId}`);
  if (scope.pendingWithTeamId) {
    // Seekers with a pending invitation or request for this team are
    // already listed with it on the team page.
    conditions.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "TeamJoinRequest" j
      WHERE j."rsvpId" = r."id" AND j."teamId" = ${scope.pendingWithTeamId}
        AND j."status" = ${TeamJoinRequestStatus.PENDING}::"TeamJoinRequestStatus"
    )`);
  }
  if (query) {
    const pattern = `%${escapeLikePattern(query)}%`;
    conditions.push(Prisma.sql`(
      s."headline" ILIKE ${pattern}
      OR EXISTS (SELECT 1 FROM unnest(s."skills") AS skill WHERE skill ILIKE ${pattern})
      OR (regexp_split_to_array(btrim(COALESCE(NULLIF(btrim(u."name"), ''), r."guestName", '')), '[[:space:]]+'))[1] ILIKE ${pattern}
    )`);
  }
  return conditions;
}

/** One page of visible seekers, most recently updated first (keyset on `updatedAt DESC, id ASC`). */
async function pageVisibleSeekers(scope: SeekerScope, input: unknown): Promise<CursorPage<SeekerListItemDto>> {
  const parsed = matchingListQuerySchema.safeParse(input ?? {});
  if (!parsed.success) return emptyPage();
  const { query, cursor } = parsed.data;
  const base = seekerListConditions(scope, query);
  const conditions = [...base];
  if (cursor) {
    const after = decodeKeysetCursor(cursor);
    if (!after) return emptyPage();
    const at = sqlTimestamp(after.at);
    conditions.push(Prisma.sql`(s."updatedAt" < ${at}::timestamp(3) OR (s."updatedAt" = ${at}::timestamp(3) AND s."id" > ${after.id}))`);
  }
  const [ids, counted] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; updatedAt: Date }>>`
      SELECT s."id", s."updatedAt" FROM ${SEEKER_FROM}
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY s."updatedAt" DESC, s."id" ASC
      LIMIT ${TEAM_MATCHING_PAGE_SIZE + 1}`,
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS "count" FROM ${SEEKER_FROM} WHERE ${Prisma.join(base, " AND ")}`,
  ]);
  const total = Number(counted[0]?.count ?? 0);
  const page = ids.slice(0, TEAM_MATCHING_PAGE_SIZE);
  const last = page[page.length - 1];
  if (!last) return emptyPage(total);
  const rows = await prisma.teamSeekerProfile.findMany({
    where: { id: { in: page.map((row) => row.id) }, visible: true, rsvp: { eventId: scope.eventId, teamId: null } },
    select: seekerRowSelect,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    items: seekerListDto(page.flatMap((row) => byId.get(row.id) ?? [])),
    nextCursor: ids.length > TEAM_MATCHING_PAGE_SIZE ? encodeKeysetCursor(last.updatedAt, last.id) : null,
    total,
  };
}

/**
 * Seeker list for a leader of a non-rejected team with free space; otherwise
 * null. Re-checked on every page, so "Show more" stops working as soon as the
 * team fills up, is declined, or the leader loses the link.
 */
export async function listSeekersForLeader(auth: TeamLeaderAuth, input: unknown = {}): Promise<CursorPage<SeekerListItemDto> | null> {
  const team = await prisma.team.findFirst({
    where: { id: auth.teamId, eventId: auth.eventId },
    select: {
      status: true,
      manageTokenHash: true,
      leaderRsvp: { select: { userId: true } },
      _count: { select: { members: true } },
      event: { select: { registrationMode: true, soloPolicy: true, teamMaxSize: true } },
    },
  });
  if (!team || !isMatchingEvent(team.event) || team.status === RsvpStatus.REJECTED) return null;
  if (!leaderAuthMatches(auth, team)) return null;
  if (!hasFreeSpace(team.event, team._count.members)) return null;
  return pageVisibleSeekers({ eventId: auth.eventId, pendingWithTeamId: auth.teamId }, input);
}

/** Seeker-side gate: the holder is a solo registrant with a visible profile on a matching event. */
async function visibleSeekerHolder(holder: TicketHolder) {
  const rsvp = await prisma.rSVP.findFirst({
    where: { id: holder.rsvpId, eventId: holder.eventId, teamId: null, status: { not: RsvpStatus.REJECTED }, seekerProfile: { visible: true } },
    select: { id: true, event: { select: { registrationMode: true, soloPolicy: true, teamMaxSize: true } } },
  });
  return rsvp?.event && isMatchingEvent(rsvp.event) ? rsvp : null;
}

/** Other visible seekers of the same event, for a visible seeker; otherwise null. */
export async function listSeekersForSeeker(holder: TicketHolder, input: unknown = {}): Promise<CursorPage<SeekerListItemDto> | null> {
  if (!(await visibleSeekerHolder(holder))) return null;
  return pageVisibleSeekers({ eventId: holder.eventId, excludeRsvpId: holder.rsvpId }, input);
}

/** `requested`: the holder already has a pending request with this team. */
export type LookingTeamDto = { id: string; name: string; size: number; maxSize: number | null; requested: boolean };

/**
 * Teams that are looking for members and have space, for a visible seeker;
 * otherwise null. Oldest first (keyset on `createdAt, id`); the free-space
 * test is in the query, so full teams never take a place on a page. A search
 * matches the team name.
 */
export async function listTeamsLookingForMembers(holder: TicketHolder, input: unknown = {}): Promise<CursorPage<LookingTeamDto> | null> {
  const seeker = await visibleSeekerHolder(holder);
  if (!seeker?.event) return null;
  const parsed = matchingListQuerySchema.safeParse(input ?? {});
  if (!parsed.success) return emptyPage();
  const { query, cursor } = parsed.data;
  const maxSize = seeker.event.teamMaxSize;
  // Without a maximum no team has free space (`hasFreeSpace`).
  if (maxSize == null) return emptyPage();
  const base = [
    Prisma.sql`t."eventId" = ${holder.eventId}`,
    Prisma.sql`t."lookingForMembers" = true`,
    Prisma.sql`t."status" <> ${RsvpStatus.REJECTED}::"RsvpStatus"`,
    Prisma.sql`(SELECT count(*) FROM "RSVP" r WHERE r."teamId" = t."id") < ${maxSize}`,
  ];
  if (query) base.push(Prisma.sql`t."name" ILIKE ${`%${escapeLikePattern(query)}%`}`);
  const conditions = [...base];
  if (cursor) {
    const after = decodeKeysetCursor(cursor);
    if (!after) return emptyPage();
    conditions.push(Prisma.sql`(t."createdAt", t."id") > (${sqlTimestamp(after.at)}::timestamp(3), ${after.id})`);
  }
  const [ids, counted] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; createdAt: Date }>>`
      SELECT t."id", t."createdAt" FROM "Team" t
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY t."createdAt" ASC, t."id" ASC
      LIMIT ${TEAM_MATCHING_PAGE_SIZE + 1}`,
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS "count" FROM "Team" t WHERE ${Prisma.join(base, " AND ")}`,
  ]);
  const total = Number(counted[0]?.count ?? 0);
  const page = ids.slice(0, TEAM_MATCHING_PAGE_SIZE);
  const last = page[page.length - 1];
  if (!last) return emptyPage(total);
  const pageIds = page.map((row) => row.id);
  const [teams, requests] = await Promise.all([
    prisma.team.findMany({
      where: { id: { in: pageIds }, eventId: holder.eventId },
      select: { id: true, name: true, _count: { select: { members: true } } },
    }),
    prisma.teamJoinRequest.findMany({
      where: { rsvpId: holder.rsvpId, teamId: { in: pageIds }, status: TeamJoinRequestStatus.PENDING, direction: TeamJoinRequestDirection.REQUEST },
      select: { teamId: true },
    }),
  ]);
  const byId = new Map(teams.map((team) => [team.id, team]));
  const requested = new Set(requests.map((request) => request.teamId));
  return {
    items: page.flatMap((row) => {
      const team = byId.get(row.id);
      return team ? [{ id: team.id, name: team.name, size: team._count.members, maxSize, requested: requested.has(team.id) }] : [];
    }),
    nextCursor: ids.length > TEAM_MATCHING_PAGE_SIZE ? encodeKeysetCursor(last.createdAt, last.id) : null,
    total,
  };
}
