import "server-only";

/** Organiser read models for Judging → Rounds (docs/HACKATHON.md "Rounds"). */

import { JudgingRoundEntrySource, JudgingRoundStatus, ScoreNormalization, SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { entrantDisplayName } from "@/lib/judgingDto";
import { FINALISTS_LIMIT } from "@/lib/validators/judgingRounds";
import { criteriaFor, isId, nameSourceSelect } from "../shared";
import { currentRoundOf, roundSelect, toRoundScope } from "./scope";
import type { JudgingCriterionDto } from "@/lib/judgingDto";

export type JudgingRoundDto = {
  id: string;
  name: string;
  position: number;
  status: JudgingRoundStatus;
  entrySource: JudgingRoundEntrySource;
  judgesSeeAll: boolean;
  freshEyes: boolean;
  reviewsPerProject: number | null;
  scoreNormalization: ScoreNormalization;
  opensAt: Date | null;
  closesAt: Date | null;
  finalistsPublishedAt: Date | null;
  finalizedAt: Date | null;
  isCurrent: boolean;
  isFinal: boolean;
  /** The round's own panel; empty when everyone who can judge the event judges it. */
  panelUserIds: string[];
  criteria: JudgingCriterionDto[];
  /** Advanced projects still SUBMITTED (ADVANCED rounds). */
  finalists: number;
  reviewsSubmitted: number;
};

/** Every round of the event in order, with its rubric, panel and counts. Owners and admins only (the caller checks). */
export async function loadJudgingRounds(ctx: JudgingOrganiserContext): Promise<JudgingRoundDto[] | null> {
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: { id: true } });
  if (!event) return null;
  const rows = await prisma.judgingRound.findMany({ where: { eventId: event.id }, orderBy: { position: "asc" }, select: roundSelect });
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [finalists, reviews, criteria] = await Promise.all([
    prisma.judgingRoundEntry.groupBy({ by: ["roundId"], where: { roundId: { in: ids }, submission: { status: SubmissionStatus.SUBMITTED } }, _count: { _all: true } }),
    prisma.judgeReview.groupBy({ by: ["roundId"], where: { roundId: { in: ids }, submittedAt: { not: null } }, _count: { _all: true } }),
    Promise.all(rows.map((row) => criteriaFor(prisma, { id: row.id, eventId: event.id }))),
  ]);
  const finalistsBy = new Map(finalists.map((row) => [row.roundId, row._count._all]));
  const reviewsBy = new Map(reviews.map((row) => [row.roundId, row._count._all]));
  const current = currentRoundOf(rows);
  return rows.map((row, index) => {
    const scope = toRoundScope(row, rows);
    return {
      id: row.id,
      name: row.name,
      position: row.position,
      status: row.status,
      entrySource: row.entrySource,
      judgesSeeAll: row.judgesSeeAll,
      freshEyes: row.freshEyes,
      reviewsPerProject: row.reviewsPerProject,
      scoreNormalization: row.scoreNormalization,
      opensAt: row.opensAt,
      closesAt: row.closesAt,
      finalistsPublishedAt: row.finalistsPublishedAt,
      finalizedAt: row.finalizedAt,
      isCurrent: row.id === current?.id,
      isFinal: scope.isFinal,
      panelUserIds: scope.panelUserIds ?? [],
      criteria: criteria[index]!,
      finalists: finalistsBy.get(row.id) ?? 0,
      reviewsSubmitted: reviewsBy.get(row.id) ?? 0,
    };
  });
}

export type RoundFinalistDto = { submissionId: string; title: string; entrantName: string; sourceRank: number | null; status: SubmissionStatus };

/** One round's advanced projects (organiser view, bounded), best source rank first. */
export async function loadRoundFinalists(ctx: JudgingOrganiserContext, roundId: unknown): Promise<RoundFinalistDto[] | null> {
  if (!isId(roundId)) return null;
  const round = await prisma.judgingRound.findFirst({ where: { id: roundId, eventId: ctx.eventId, event: { organisationId: ctx.organisationId } }, select: { id: true } });
  if (!round) return null;
  const entries = await prisma.judgingRoundEntry.findMany({
    where: { roundId: round.id },
    orderBy: [{ sourceRank: { sort: "asc", nulls: "last" } }, { submissionId: "asc" }],
    take: FINALISTS_LIMIT,
    select: { sourceRank: true, submission: { select: { id: true, title: true, status: true, ...nameSourceSelect } } },
  });
  return entries.map((entry) => ({
    submissionId: entry.submission.id,
    title: entry.submission.title,
    entrantName: entrantDisplayName(entry.submission),
    sourceRank: entry.sourceRank,
    status: entry.submission.status,
  }));
}
