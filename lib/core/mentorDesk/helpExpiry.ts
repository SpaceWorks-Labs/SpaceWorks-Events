import "server-only";

/*
 * The `help-queue-expiry` beat job (help_expiry.expire): every minute,
 * release lapsed claims back to OPEN (a new open generation) and expire
 * requests past their deadline, min(expiresAt, event end). Rows are taken
 * with FOR UPDATE SKIP LOCKED and the action is re-derived from the locked
 * row, so two beats (or a beat racing a renewal) never double-apply. It runs
 * whether or not the desk is on: expiry only removes authority. Commands
 * re-check the clock themselves, so reads never need to mutate.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { expiryAction, HELP_EXPIRY_BATCH } from "@/lib/mentorDesk/rules";
import { sqlUtcTimestamp } from "@/lib/sqlTimestamp";
import { lockHelpRow, releaseLocked } from "./helpShared";

export async function expireHelpRequests(now: Date = new Date(), limit = HELP_EXPIRY_BATCH): Promise<{ expired: number; released: number }> {
  const take = Math.min(Math.max(limit, 1), HELP_EXPIRY_BATCH);
  const at = sqlUtcTimestamp(now);
  return prisma.$transaction(async (tx) => {
    const due = await tx.$queryRaw<Array<{ id: string; eventId: string }>>(Prisma.sql`
      SELECT hr."id", hr."eventId"
      FROM "HelpRequest" hr
      JOIN "Event" e ON e."id" = hr."eventId"
      WHERE hr."status" IN ('OPEN', 'CLAIMED')
        AND (hr."expiresAt" <= ${at} OR e."endDateTime" <= ${at} OR (hr."status" = 'CLAIMED' AND hr."claimExpiresAt" <= ${at}))
      ORDER BY hr."id"
      LIMIT ${take}
      FOR UPDATE OF hr SKIP LOCKED`);
    let expired = 0;
    let released = 0;
    const ends = new Map<string, Date>();
    for (const item of due) {
      if (!ends.has(item.eventId)) ends.set(item.eventId, (await tx.event.findUniqueOrThrow({ where: { id: item.eventId }, select: { endDateTime: true } })).endDateTime);
      const row = await lockHelpRow(tx, item.eventId, item.id);
      const action = expiryAction(row, ends.get(item.eventId)!, now);
      if (!action) continue;
      await releaseLocked(tx, row, { terminal: action === "expire", kind: action === "expire" ? "expired" : "lease_expired", now });
      if (action === "expire") expired += 1;
      else released += 1;
    }
    return { expired, released };
  }, { timeout: 30_000 });
}
