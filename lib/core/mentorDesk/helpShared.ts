import "server-only";

/** Shared pieces of the help queue state machine (help_workflow.py, help_expiry.py). */

import { HelpRequestStatus, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { claimLeaseExpiry, helpDeadline, helpLiveness } from "@/lib/mentorDesk/rules";
import { COPY, refuse } from "./shared";

export const helpRowSelect = {
  id: true,
  eventId: true,
  teamId: true,
  rsvpId: true,
  raisedByUserId: true,
  origin: true,
  status: true,
  claimedByUserId: true,
  claimId: true,
  claimGeneration: true,
  claimExpiresAt: true,
  openGeneration: true,
  exclusiveUntil: true,
  expiresAt: true,
  firstClaimedAt: true,
  rating: true,
  version: true,
  categoryId: true,
  category: { select: { skillTags: true, claimMinutes: true, openLimit: true } },
} satisfies Prisma.HelpRequestSelect;

export type HelpRow = Prisma.HelpRequestGetPayload<{ select: typeof helpRowSelect }>;

/** Locks and re-reads one request of this event (select_for_update). */
export async function lockHelpRow(tx: Prisma.TransactionClient, eventId: string, requestId: string): Promise<HelpRow> {
  await tx.$queryRaw`SELECT "id" FROM "HelpRequest" WHERE "id" = ${requestId} AND "eventId" = ${eventId} FOR UPDATE`;
  const row = await tx.helpRequest.findFirst({ where: { id: requestId, eventId }, select: helpRowSelect });
  if (!row) refuse(COPY.notFound);
  return row;
}

/** help_expiry.require_live: commands never trust the beat to have run. */
export function requireLive(row: HelpRow, eventEnd: Date, now: Date) {
  const liveness = helpLiveness(row, eventEnd, now);
  if (liveness === "expired") refuse(COPY.expired);
  if (liveness === "lease-lost") refuse(COPY.leaseLost);
}

/** Deadline only: commands that end or move a claim (team cancel, organiser release or assign) work on a lapsed lease too. */
export function requireBeforeDeadline(row: HelpRow, eventEnd: Date, now: Date) {
  if (row.status === "EXPIRED" || helpDeadline(row.expiresAt, eventEnd).getTime() <= now.getTime()) refuse(COPY.expired);
}

export function requireStatus(row: { status: HelpRequestStatus }, ...allowed: HelpRequestStatus[]) {
  if (!allowed.includes(row.status)) refuse(COPY.stale);
}

/** help_expiry.claim_values: a fresh claim id, the next generation and a bounded lease. */
export function claimValues(row: HelpRow, eventEnd: Date, now: Date) {
  return {
    claimId: randomUUID(),
    claimGeneration: row.claimGeneration + 1,
    claimExpiresAt: claimLeaseExpiry(now, row.category.claimMinutes, helpDeadline(row.expiresAt, eventEnd)),
  };
}

/** The fields that clear a claim (release, resolve, cancel, expiry). */
export const CLEARED_CLAIM = { claimedByUserId: null, claimId: null, claimExpiresAt: null } as const;

/** Writes the new state with a version bump, and its append-only activity row. */
export async function changeHelp(tx: Prisma.TransactionClient, row: HelpRow, data: Prisma.HelpRequestUncheckedUpdateInput, activity: { actorUserId: string | null; kind: string; note?: string }) {
  await tx.helpRequest.update({ where: { id: row.id }, data: { ...data, version: { increment: 1 } } });
  await tx.helpRequestActivity.create({ data: { requestId: row.id, eventId: row.eventId, actorUserId: activity.actorUserId, kind: activity.kind, note: activity.note ?? "" } });
}

/**
 * help_expiry.release_locked: a lapsed claim goes back to OPEN (a new open
 * generation) or, past the deadline, to EXPIRED. The caller holds the row lock.
 */
export async function releaseLocked(tx: Prisma.TransactionClient, row: HelpRow, options: { terminal: boolean; kind: string; actorUserId?: string | null; now: Date }) {
  await changeHelp(tx, row, {
    status: options.terminal ? HelpRequestStatus.EXPIRED : HelpRequestStatus.OPEN,
    ...CLEARED_CLAIM,
    lastOpenedAt: options.now,
    openGeneration: row.openGeneration + 1,
  }, { actorUserId: options.actorUserId ?? null, kind: options.kind });
}

/**
 * Before a mentor takes a claim: refuse while they hold another live one
 * (mentor_busy), and release their lapsed ones under the row lock so the
 * one-claim-per-mentor index never sees a stale claim. It locks requests
 * other than the caller's, so callers hold the Event lock (helpCommands.ts).
 */
export async function clearMentorClaims(tx: Prisma.TransactionClient, eventId: string, mentorUserId: string, exceptId: string, eventEnd: Date, now: Date) {
  const held = await tx.helpRequest.findMany({ where: { eventId, claimedByUserId: mentorUserId, status: HelpRequestStatus.CLAIMED, id: { not: exceptId } }, select: { id: true } });
  for (const { id } of held) {
    const stale = await lockHelpRow(tx, eventId, id);
    if (stale.status !== HelpRequestStatus.CLAIMED || stale.claimedByUserId !== mentorUserId) continue;
    if (stale.claimExpiresAt && stale.claimExpiresAt.getTime() > now.getTime()) refuse(COPY.busy);
    const terminal = helpDeadline(stale.expiresAt, eventEnd).getTime() <= now.getTime();
    await releaseLocked(tx, stale, { terminal, kind: terminal ? "expired" : "lease_expired", now });
  }
}
