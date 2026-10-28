import "server-only";

/** Keep an event's current round and its mirrored event-level judging fields in step (docs/HACKATHON.md "Rounds"). */

import { Prisma } from "@prisma/client";
import { currentRoundOf, judgingStatusFor, type JudgingRoundScope, resolveJudgingRound, type RoundFallbackEvent } from "./scope";

/**
 * The event's current round, creating its first ("Main") round from the
 * event-level fields when it has none. Organiser writes only, under the
 * Event row lock (`FOR UPDATE`), so two callers never race to create it; the
 * database function does the same for writers that predate rounds.
 */
export async function ensureJudgingRound(tx: Prisma.TransactionClient, event: RoundFallbackEvent): Promise<JudgingRoundScope> {
  const existing = await resolveJudgingRound(tx, event);
  if (existing?.id) return existing;
  await tx.$queryRaw`SELECT "judging_current_round"(${event.id})`;
  await syncCurrentRound(tx, event.id);
  const created = await resolveJudgingRound(tx, event);
  if (!created?.id) throw new Error("The event's first judging round could not be created.");
  return created;
}

/**
 * Point the event at its current round (the latest round that has opened,
 * else the first) and copy that round's status, visibility, target and score
 * method onto the event-level fields, which mirror it for this release. Call
 * after any change to a round's status or settings, under the Event row lock.
 */
export async function syncCurrentRound(tx: Prisma.TransactionClient, eventId: string): Promise<void> {
  const rounds = await tx.judgingRound.findMany({
    where: { eventId },
    orderBy: { position: "asc" },
    select: { id: true, status: true, judgesSeeAll: true, reviewsPerProject: true, scoreNormalization: true },
  });
  const current = currentRoundOf(rounds);
  if (!current) return;
  const event = await tx.event.findUnique({
    where: { id: eventId },
    select: { currentJudgingRoundId: true, judgingStatus: true, judgesSeeAll: true, reviewsPerProject: true, scoreNormalization: true },
  });
  if (!event) return;
  const next = {
    currentJudgingRoundId: current.id,
    judgingStatus: judgingStatusFor(current.status),
    judgesSeeAll: current.judgesSeeAll,
    reviewsPerProject: current.reviewsPerProject,
    scoreNormalization: current.scoreNormalization,
  };
  const unchanged = (Object.keys(next) as Array<keyof typeof next>).every((key) => event[key] === next[key]);
  if (!unchanged) await tx.event.update({ where: { id: eventId }, data: next });
}
