import "server-only";

/**
 * Who may hold an award (docs/HACKATHON.md "Rounds"): awards come from the
 * final judging round, so when that round judges advanced finalists only its
 * finalists can win. The one rule for picking winners, publishing results,
 * the public results page and prize payouts.
 */

import { JudgingRoundEntrySource, Prisma } from "@prisma/client";

/** The final round when it takes advanced finalists (a later round, ADVANCED); null when every SUBMITTED project may win. */
export async function finalistOnlyRound(client: Prisma.TransactionClient, eventId: string): Promise<{ id: string; position: number } | null> {
  const last = await client.judgingRound.findFirst({ where: { eventId }, orderBy: { position: "desc" }, select: { id: true, position: true, entrySource: true } });
  return last && last.position > 1 && last.entrySource === JudgingRoundEntrySource.ADVANCED ? { id: last.id, position: last.position } : null;
}

/** Prisma condition on a Submission: may hold an award (a finalist of the final round when it takes finalists). */
export async function awardEligibleWhere(client: Prisma.TransactionClient, eventId: string): Promise<Prisma.SubmissionWhereInput> {
  const round = await finalistOnlyRound(client, eventId);
  return round ? { roundEntries: { some: { roundId: round.id } } } : {};
}

/** How many of the event's award winners aren't eligible (not finalists of a final round that takes finalists). */
export async function ineligibleAwardWinners(client: Prisma.TransactionClient, eventId: string): Promise<number> {
  const round = await finalistOnlyRound(client, eventId);
  if (!round) return 0;
  return client.eventAwardWinner.count({ where: { award: { eventId }, submission: { roundEntries: { none: { roundId: round.id } } } } });
}
