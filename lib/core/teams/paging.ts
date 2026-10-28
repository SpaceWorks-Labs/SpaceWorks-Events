import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { decodeTimeCursor, encodeTimeCursor } from "@/lib/keysetCursor";

/** Keyset cursors, page sizes and list query schemas shared by the team read models. */

/** Rows per page in the attendee-side matching lists (seekers, teams looking for members, pending requests). */
export const TEAM_MATCHING_PAGE_SIZE = 20;

/** One bounded page of a list, the keyset cursor for the next one, and the size of the whole list. */
export type CursorPage<T> = { items: T[]; nextCursor: string | null; total: number };

export function emptyPage<T>(total = 0): CursorPage<T> {
  return { items: [], nextCursor: null, total };
}

/** Search text and cursor for the seeker and team lists ("Show more"). */
export const matchingListQuerySchema = z
  .object({
    query: z.string().trim().max(100).optional().default(""),
    cursor: z.string().trim().max(160).nullable().optional(),
  })
  .strict();

/** Cursor for the pending invitation and request lists. */
export const joinRequestPageQuerySchema = z.object({ cursor: z.string().trim().max(160).nullable().optional() }).strict();

/**
 * One page of pending join requests, oldest first (keyset on `createdAt, id`),
 * with the count of all rows matching `where`.
 */
export async function pageJoinRequests<R extends { id: string; createdAt: Date }, T>(
  where: Prisma.TeamJoinRequestWhereInput,
  cursor: string | null | undefined,
  find: (args: { where: Prisma.TeamJoinRequestWhereInput; take: number }) => Promise<R[]>,
  map: (row: R) => T,
): Promise<CursorPage<T>> {
  let pageWhere = where;
  if (cursor) {
    const after = decodeKeysetCursor(cursor);
    if (!after) return emptyPage();
    pageWhere = { AND: [where, { OR: [{ createdAt: { gt: after.at } }, { createdAt: after.at, id: { gt: after.id } }] }] };
  }
  const [rows, total] = await Promise.all([
    find({ where: pageWhere, take: TEAM_MATCHING_PAGE_SIZE + 1 }),
    prisma.teamJoinRequest.count({ where }),
  ]);
  const page = rows.slice(0, TEAM_MATCHING_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    items: page.map(map),
    nextCursor: rows.length > TEAM_MATCHING_PAGE_SIZE && last ? encodeKeysetCursor(last.createdAt, last.id) : null,
    total,
  };
}

/** Opaque keyset cursor: the last row's sort time (ms) and id. */
/** The shared `<epoch ms>.<id>` keyset cursor (lib/keysetCursor.ts). */
export function encodeKeysetCursor(at: Date, id: string): string {
  return encodeTimeCursor({ at, id });
}

export function decodeKeysetCursor(cursor: string): { at: Date; id: string } | null {
  return decodeTimeCursor(cursor);
}

/** The organiser Teams view's cursor: the last team's creation time and id. */
export function encodeTeamCursor(team: { createdAt: Date; id: string }): string {
  return encodeKeysetCursor(team.createdAt, team.id);
}

export function decodeTeamCursor(cursor: string): { createdAt: Date; id: string } | null {
  const after = decodeKeysetCursor(cursor);
  return after ? { createdAt: after.at, id: after.id } : null;
}

/** `%`, `_` and `\` match literally in the search text. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
