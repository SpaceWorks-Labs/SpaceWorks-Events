import "server-only";

/** Shared judging-ops helpers: result builders, the ops event select and its organiser lock. */

import { Prisma } from "@prisma/client";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";

export const EVENT_NOT_FOUND = "Event not found.";

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

export function fail(error: string, fieldErrors?: Record<string, string[]>): { ok: false; error: string; fieldErrors?: Record<string, string[]> } {
  return fieldErrors ? { ok: false, error, fieldErrors } : { ok: false, error };
}

export const opsEventSelect = {
  id: true,
  organisationId: true,
  judgingStatus: true,
  judgesSeeAll: true,
  resultsPublishedAt: true,
  reviewsPerProject: true,
  scoreNormalization: true,
} satisfies Prisma.EventSelect;

export type OpsEvent = Prisma.EventGetPayload<{ select: typeof opsEventSelect }>;

export async function lockOpsEvent(tx: Prisma.TransactionClient, ctx: JudgingOrganiserContext): Promise<OpsEvent | null> {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${ctx.eventId} AND "organisationId" = ${ctx.organisationId} FOR UPDATE`;
  return tx.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: opsEventSelect });
}
