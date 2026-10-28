import "server-only";

/**
 * Judging rounds (docs/HACKATHON.md "Rounds"): which round a read or write
 * is about, and the projects that round judges.
 *
 * Every event with judging has at least one round once anything is set up
 * (the migration backfilled a "Main" round; `ensureJudgingRound` and a
 * database trigger create one on first use). The **current** round is the
 * latest round that has opened, else the first; the event-level judging
 * fields mirror it for this release. With no round at all (an event that
 * never touched judging) reads use a stand-in built from the event's fields
 * with `id: null`, which matches no criterion, assignment or review.
 */

import { JudgingRoundEntrySource, JudgingRoundStatus, JudgingStatus, Prisma, ScoreNormalization, SubmissionStatus } from "@prisma/client";

export type JudgingRoundScope = {
  /** Null only for an event with no round yet: nothing belongs to it. */
  id: string | null;
  eventId: string;
  name: string;
  position: number;
  status: JudgingRoundStatus;
  entrySource: JudgingRoundEntrySource;
  judgesSeeAll: boolean;
  /** Fresh eyes: a judge never sees or gets a project they reviewed in an earlier round. */
  freshEyes: boolean;
  reviewsPerProject: number | null;
  scoreNormalization: ScoreNormalization;
  finalistsPublishedAt: Date | null;
  /** Set once the organiser finalised the round (CLOSED for good); finalists advance only from a finalised round. */
  finalizedAt: Date | null;
  /** The round judges work on now (see above). */
  isCurrent: boolean;
  /** The highest position: results, awards and prizes come from it. */
  isFinal: boolean;
  /** The round's own judging panel; null when it has none (everyone who can judge the event). */
  panelUserIds: string[] | null;
  /** Rounds the event has (0 for the stand-in). */
  roundCount: number;
};

export const roundSelect = {
  id: true,
  eventId: true,
  name: true,
  position: true,
  status: true,
  entrySource: true,
  judgesSeeAll: true,
  freshEyes: true,
  reviewsPerProject: true,
  scoreNormalization: true,
  finalistsPublishedAt: true,
  finalizedAt: true,
  opensAt: true,
  closesAt: true,
  panel: { select: { userId: true }, orderBy: [{ createdAt: "asc" }, { userId: "asc" }] },
} satisfies Prisma.JudgingRoundSelect;

export type RoundRow = Prisma.JudgingRoundGetPayload<{ select: typeof roundSelect }>;

/** The event fields a round falls back to before the event has any round. */
export type RoundFallbackEvent = {
  id: string;
  judgingStatus: JudgingStatus;
  judgesSeeAll: boolean;
  reviewsPerProject?: number | null;
  scoreNormalization?: ScoreNormalization;
};

export function roundStatusFor(status: JudgingStatus): JudgingRoundStatus {
  if (status === JudgingStatus.OPEN) return JudgingRoundStatus.OPEN;
  if (status === JudgingStatus.CLOSED) return JudgingRoundStatus.CLOSED;
  return JudgingRoundStatus.DRAFT;
}

/** A round's status in the event-level vocabulary (what the judging screens already speak). */
export function judgingStatusFor(status: JudgingRoundStatus): JudgingStatus {
  if (status === JudgingRoundStatus.OPEN) return JudgingStatus.OPEN;
  if (status === JudgingRoundStatus.CLOSED) return JudgingStatus.CLOSED;
  return JudgingStatus.NOT_STARTED;
}

/** The latest round that has left DRAFT, else the first. `rounds` in position order. */
export function currentRoundOf<T extends { status: JudgingRoundStatus }>(rounds: readonly T[]): T | null {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    if (rounds[index]!.status !== JudgingRoundStatus.DRAFT) return rounds[index]!;
  }
  return rounds[0] ?? null;
}

export function toRoundScope(row: RoundRow, rounds: readonly { id: string; status: JudgingRoundStatus; position: number }[]): JudgingRoundScope {
  const current = currentRoundOf(rounds);
  const last = rounds[rounds.length - 1];
  return {
    id: row.id,
    eventId: row.eventId,
    name: row.name,
    position: row.position,
    status: row.status,
    entrySource: row.entrySource,
    judgesSeeAll: row.judgesSeeAll,
    freshEyes: row.freshEyes,
    reviewsPerProject: row.reviewsPerProject,
    scoreNormalization: row.scoreNormalization,
    finalistsPublishedAt: row.finalistsPublishedAt,
    finalizedAt: row.finalizedAt,
    isCurrent: current?.id === row.id,
    isFinal: last?.id === row.id,
    panelUserIds: row.panel.length > 0 ? row.panel.map((member) => member.userId) : null,
    roundCount: rounds.length,
  };
}

/** The stand-in for an event with no round yet. */
export function fallbackRoundScope(event: RoundFallbackEvent): JudgingRoundScope {
  return {
    id: null,
    eventId: event.id,
    name: "Main",
    position: 1,
    status: roundStatusFor(event.judgingStatus),
    entrySource: JudgingRoundEntrySource.ALL_SUBMITTED,
    judgesSeeAll: event.judgesSeeAll,
    freshEyes: false,
    reviewsPerProject: event.reviewsPerProject ?? null,
    scoreNormalization: event.scoreNormalization ?? ScoreNormalization.RAW,
    finalistsPublishedAt: null,
    finalizedAt: null,
    isCurrent: true,
    isFinal: true,
    panelUserIds: null,
    roundCount: 0,
  };
}

/**
 * The round a read or write is about: `roundId` when given (null when it is
 * not one of this event's rounds), else the current round, else the stand-in.
 * Read on `client` (the caller's transaction when it holds the Event lock).
 */
export async function resolveJudgingRound(client: Prisma.TransactionClient, event: RoundFallbackEvent, roundId?: string | null): Promise<JudgingRoundScope | null> {
  const rounds = await client.judgingRound.findMany({ where: { eventId: event.id }, orderBy: { position: "asc" }, select: roundSelect });
  if (roundId) {
    const row = rounds.find((round) => round.id === roundId);
    return row ? toRoundScope(row, rounds) : null;
  }
  const current = currentRoundOf(rounds);
  return current ? toRoundScope(current, rounds) : fallbackRoundScope(event);
}

/** Whether a judge (already eligible for the event) is on this round's panel. */
export function onRoundPanel(round: Pick<JudgingRoundScope, "panelUserIds">, userId: string): boolean {
  return round.panelUserIds == null || round.panelUserIds.includes(userId);
}

/**
 * SQL conditions (on `"Submission" s`) for the projects a round judges:
 * SUBMITTED projects of its event, and for an ADVANCED round only those
 * advanced into it. A disqualified or withdrawn entry drops out on its own.
 */
export function roundProjectsSql(round: Pick<JudgingRoundScope, "id" | "eventId" | "entrySource">): Prisma.Sql[] {
  const conditions = [Prisma.sql`s."eventId" = ${round.eventId}`, Prisma.sql`s."status" = ${SubmissionStatus.SUBMITTED}::"SubmissionStatus"`];
  if (round.entrySource === JudgingRoundEntrySource.ADVANCED) {
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "JudgingRoundEntry" re WHERE re."submissionId" = s."id" AND re."roundId" = ${round.id})`);
  }
  return conditions;
}

/** The same rule as `roundProjectsSql`, for Prisma queries; `statuses` widens it (the results table lists DISQUALIFIED rows too). */
export function roundProjectsWhere(
  round: Pick<JudgingRoundScope, "id" | "eventId" | "entrySource">,
  statuses: SubmissionStatus[] = [SubmissionStatus.SUBMITTED],
): Prisma.SubmissionWhereInput {
  return {
    eventId: round.eventId,
    status: statuses.length === 1 ? statuses[0] : { in: statuses },
    ...(round.entrySource === JudgingRoundEntrySource.ADVANCED ? { roundEntries: { some: { roundId: round.id ?? "" } } } : {}),
  };
}

/** Score rows of this round: scores follow their criterion. */
export function roundScoresWhere(round: Pick<JudgingRoundScope, "id">): Prisma.JudgeScoreWhereInput {
  return { criterion: { roundId: round.id } };
}

/** SQL condition (on `"JudgeScore" js`) keeping a round's scores. */
export function roundScoreSql(round: Pick<JudgingRoundScope, "id">, alias = "js"): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(`${alias}."criterionId"`)} IN (SELECT jc."id" FROM "JudgingCriterion" jc WHERE jc."roundId" = ${round.id})`;
}
