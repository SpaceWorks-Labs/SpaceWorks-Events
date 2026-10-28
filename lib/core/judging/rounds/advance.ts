import "server-only";

/**
 * Finalist advancement (docs/HACKATHON.md "Rounds"): preview which projects
 * of the previous, closed and finalised round move into an ADVANCED round, then apply the
 * same plan under the Event lock. The plan itself is pure
 * (lib/judgingAdvancement.ts). Advancing into the final round removes award
 * winners left out of it (only the final round's finalists can win; see
 * ./awardEligibility.ts), which the preview warns about.
 */

import { JudgingRoundEntrySource, JudgingRoundStatus, Prisma, SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { planAdvancement, type AdvancementPlan } from "@/lib/judgingAdvancement";
import { advanceFinalistsSchema, FINALISTS_LIMIT } from "@/lib/validators/judgingRounds";
import { fail, invalid, isId, type JudgingEvent, judgingEventSelect, type JudgingResult, lockEventForOrganiser, ok } from "../shared";
import { loadJudgingResults, type ResultRowDto } from "../results";
import { type JudgingRoundScope, resolveJudgingRound } from "./scope";

const ROUND_NOT_FOUND = "Judging round not found.";
const PLAN_CHANGED = "Scores, projects or finalists changed since the preview. Preview again before applying.";

export type AdvancementCandidateDto = { submissionId: string; title: string; entrantName: string; rank: number | null; score: number | null; advanced: boolean };

export type AdvancementPreviewDto = {
  sourceRound: { id: string; name: string };
  targetRound: { id: string; name: string };
  /** Finalists the plan advances, in ranking order (the first FINALISTS_LIMIT). */
  finalists: AdvancementCandidateDto[];
  added: number;
  removed: number;
  kept: number;
  tieAtCutoff: boolean;
  /** Award winners this plan would remove: projects left out of the final round. */
  awardWinnersRemoved: number;
  /** The previous round's SUBMITTED projects in ranking order, for hand-picking (the first FINALISTS_LIMIT). */
  candidates: AdvancementCandidateDto[];
  candidatesTotal: number;
  fingerprint: string;
};

type Built = { ok: true; source: JudgingRoundScope & { id: string }; target: JudgingRoundScope & { id: string }; ranking: ResultRowDto[]; plan: AdvancementPlan; existing: string[] };

/** Award winners outside the plan's finalists, when the target is the final round (else none: a later round decides). */
function winnersLeftOutWhere(event: JudgingEvent, built: Built): Prisma.EventAwardWinnerWhereInput | null {
  if (!built.target.isFinal) return null;
  return { award: { eventId: event.id }, submissionId: { notIn: built.plan.chosen.map((row) => row.submissionId) } };
}

/** Check the target round and its source, read the source ranking, and plan. */
async function buildAdvancement(client: Prisma.TransactionClient, ctx: JudgingOrganiserContext, event: JudgingEvent, roundId: string, input: unknown): Promise<Built | { ok: false; error: string; fieldErrors?: Record<string, string[]> }> {
  const parsed = advanceFinalistsSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const target = await resolveJudgingRound(client, event, roundId);
  if (!target?.id) return fail(ROUND_NOT_FOUND);
  if (target.entrySource !== JudgingRoundEntrySource.ADVANCED) return fail("This round judges every submitted project, so it takes no finalists.");
  if (target.status !== JudgingRoundStatus.DRAFT) return fail("Finalists are fixed once the round opens.");
  if (target.finalistsPublishedAt) return fail("Unpublish this round's finalists before changing them.");
  const sourceRow = await client.judgingRound.findFirst({ where: { eventId: event.id, position: target.position - 1 }, select: { id: true } });
  const source = sourceRow ? await resolveJudgingRound(client, event, sourceRow.id) : null;
  if (!source?.id) return fail("Finalists come from the round before this one, and there isn't one.");
  if (source.status !== JudgingRoundStatus.CLOSED) return fail(`Close “${source.name}” before advancing its finalists.`);
  if (!source.finalizedAt) return fail(`Finalise “${source.name}” before advancing its finalists.`);
  // The source round is closed, so its scores are frozen; the ranking is the Results table's.
  const results = await loadJudgingResults(ctx, { roundId: source.id });
  if (!results) return fail(ROUND_NOT_FOUND);
  const ranking = results.rows.filter((row) => row.status === SubmissionStatus.SUBMITTED);
  const existing = (await client.judgingRoundEntry.findMany({ where: { roundId: target.id }, select: { submissionId: true } })).map((row) => row.submissionId);
  const { fingerprint: _ignored, ...request } = parsed.data;
  void _ignored;
  const plan = planAdvancement({ targetRoundId: target.id, ranking, existing, request });
  if (plan.rejected.length) return fail("Some of the projects you picked aren't submitted projects of the previous round. Refresh and try again.");
  if (plan.chosen.length === 0) return fail("No scored projects to advance yet.");
  return { ok: true, source: { ...source, id: source.id }, target: { ...target, id: target.id }, ranking, plan, existing };
}

function candidate(row: ResultRowDto, advanced: boolean): AdvancementCandidateDto {
  return { submissionId: row.submissionId, title: row.title, entrantName: row.entrantName, rank: row.rank, score: row.score, advanced };
}

/** Preview an advancement without writing anything. */
export async function previewAdvancement(ctx: JudgingOrganiserContext, roundId: unknown, input: unknown): Promise<JudgingResult<AdvancementPreviewDto>> {
  if (!isId(roundId)) return fail(ROUND_NOT_FOUND);
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: judgingEventSelect });
  if (!event) return fail(ROUND_NOT_FOUND);
  const built = await buildAdvancement(prisma, ctx, event, roundId, input);
  if (!built.ok) return built;
  const chosen = new Set(built.plan.chosen.map((row) => row.submissionId));
  const current = new Set(built.existing);
  const leftOut = winnersLeftOutWhere(event, built);
  return ok({
    sourceRound: { id: built.source.id, name: built.source.name },
    targetRound: { id: built.target.id, name: built.target.name },
    finalists: built.ranking.filter((row) => chosen.has(row.submissionId)).slice(0, FINALISTS_LIMIT).map((row) => candidate(row, true)),
    added: built.plan.added.length,
    removed: built.plan.removed.length,
    kept: built.plan.kept,
    tieAtCutoff: built.plan.tieAtCutoff,
    awardWinnersRemoved: leftOut ? await prisma.eventAwardWinner.count({ where: leftOut }) : 0,
    candidates: built.ranking.slice(0, FINALISTS_LIMIT).map((row) => candidate(row, current.has(row.submissionId))),
    candidatesTotal: built.ranking.length,
    fingerprint: built.plan.fingerprint,
  });
}

/**
 * Apply an advancement: re-plan under the Event row lock, refuse if the plan
 * differs from the preview, then replace the round's finalists in one
 * transaction (kept finalists keep their row and get their fresh source
 * rank). Refused once the round opens or its finalists are published.
 * Into the final round, award winners left out are removed in the same
 * transaction. Audited (JUDGING_FINALISTS_ADVANCED, counts only, with
 * `awardWinnersRemoved`).
 */
export async function applyAdvancement(ctx: JudgingOrganiserContext, roundId: unknown, input: unknown): Promise<JudgingResult<{ added: number; removed: number; finalists: number }>> {
  if (!isId(roundId)) return fail(ROUND_NOT_FOUND);
  const fingerprint = typeof input === "object" && input !== null ? (input as { fingerprint?: unknown }).fingerprint : undefined;
  if (typeof fingerprint !== "string" || !fingerprint) return fail(PLAN_CHANGED);
  return prisma.$transaction(
    async (tx): Promise<JudgingResult<{ added: number; removed: number; finalists: number }>> => {
      const event = await lockEventForOrganiser(tx, ctx);
      if (!event) return fail(ROUND_NOT_FOUND);
      const built = await buildAdvancement(tx, ctx, event, roundId, input);
      if (!built.ok) return built;
      const { plan, target } = built;
      if (plan.fingerprint !== fingerprint) return fail(PLAN_CHANGED);
      if (plan.removed.length) await tx.judgingRoundEntry.deleteMany({ where: { roundId: target.id, submissionId: { in: plan.removed } } });
      const added = new Set(plan.added);
      const now = new Date();
      await tx.judgingRoundEntry.createMany({
        data: plan.chosen.filter((row) => added.has(row.submissionId)).map((row) => ({ roundId: target.id, submissionId: row.submissionId, advancedByUserId: ctx.userId, advancedAt: now, sourceRank: row.sourceRank })),
      });
      for (const row of plan.chosen) {
        if (!added.has(row.submissionId)) await tx.judgingRoundEntry.updateMany({ where: { roundId: target.id, submissionId: row.submissionId }, data: { sourceRank: row.sourceRank } });
      }
      const leftOut = winnersLeftOutWhere(event, built);
      const awardWinnersRemoved = leftOut ? (await tx.eventAwardWinner.deleteMany({ where: leftOut })).count : 0;
      await recordAuditEvent({
        client: tx,
        action: "JUDGING_FINALISTS_ADVANCED",
        actorUserId: ctx.userId,
        organisationId: ctx.organisationId,
        targetType: "Event",
        targetId: event.id,
        metadata: { round: target.position, finalists: plan.chosen.length, added: plan.added.length, removed: plan.removed.length, awardWinnersRemoved },
      });
      return ok({ added: plan.added.length, removed: plan.removed.length, finalists: plan.chosen.length });
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
