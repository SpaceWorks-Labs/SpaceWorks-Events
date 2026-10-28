"use server";

import * as rounds from "@/lib/core/judgingRounds";
import type { JudgingResult } from "@/lib/core/judging";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import type { ActionResult } from "./org";
import { revalidateRounds, roundsGate } from "./judgingRounds/gate";

/*
 * Judging → Rounds (docs/HACKATHON.md "Rounds"): rounds, their panels and
 * status, finalising, finalist advancement and publication. Owners and
 * admins only (roundsGate); every rule, lock and audit is in
 * lib/core/judgingRounds.ts. Reads are on the search rate-limit bucket.
 */

async function run<T>(input: unknown, call: (ctx: JudgingOrganiserContext, fields: Record<string, unknown>) => Promise<JudgingResult<T>>, bucket: "action" | "broadcast" = "action"): Promise<ActionResult<T>> {
  const gate = await roundsGate(input, bucket);
  if (!gate.ok) return gate;
  const result = await call(gate.ctx, gate.input);
  if (result.ok) revalidateRounds(gate.ctx);
  return result;
}

export async function addJudgingRound(input: unknown): Promise<ActionResult<{ id: string }>> {
  return run(input, (ctx, fields) => rounds.createJudgingRound(ctx, fields.round));
}

export async function editJudgingRound(input: unknown): Promise<ActionResult> {
  return run(input, (ctx, fields) => rounds.updateJudgingRound(ctx, fields.roundId, fields.round));
}

export async function removeJudgingRound(input: unknown): Promise<ActionResult> {
  return run(input, (ctx, fields) => rounds.deleteJudgingRound(ctx, fields.roundId));
}

export async function reorderJudgingRoundsAction(input: unknown): Promise<ActionResult> {
  return run(input, (ctx, fields) => rounds.reorderJudgingRounds(ctx, fields.ids));
}

export async function saveJudgingRoundPanel(input: unknown): Promise<ActionResult<{ panel: number }>> {
  return run(input, (ctx, fields) => rounds.setJudgingRoundPanel(ctx, fields.roundId, fields.userIds));
}

export async function changeJudgingRoundStatus(input: unknown): Promise<ActionResult> {
  return run(input, (ctx, fields) => rounds.setJudgingRoundStatus(ctx, fields.roundId, fields.status));
}

export async function finalizeRound(input: unknown): Promise<ActionResult<rounds.RoundCoverageDto>> {
  return run(input, (ctx, fields) => rounds.finalizeJudgingRound(ctx, fields.roundId, { reason: fields.reason }));
}

export async function unfinalizeRound(input: unknown): Promise<ActionResult> {
  return run(input, (ctx, fields) => rounds.unfinalizeJudgingRound(ctx, fields.roundId));
}

/** Plan an advancement without changing anything (read-only, no revalidation). */
export async function previewRoundFinalists(input: unknown): Promise<ActionResult<rounds.AdvancementPreviewDto>> {
  const gate = await roundsGate(input, "search");
  if (!gate.ok) return gate;
  return rounds.previewAdvancement(gate.ctx, gate.input.roundId, gate.input.plan);
}

/** Apply the previewed advancement (refused when it changed since the preview). */
export async function applyRoundFinalists(input: unknown): Promise<ActionResult<{ added: number; removed: number; finalists: number }>> {
  return run(input, (ctx, fields) => rounds.applyAdvancement(ctx, fields.roundId, fields.plan));
}

/** Publish a round's finalists and queue their announcement (the broadcast rate-limit bucket applies). */
export async function publishRoundFinalists(input: unknown): Promise<ActionResult<{ queued: number; emailed: boolean }>> {
  return run(
    input,
    async (ctx, fields) => {
      const result = await rounds.publishFinalists(ctx, fields.roundId);
      return result.ok ? { ok: true, data: { queued: result.data.queued, emailed: result.data.emailed } } : result;
    },
    "broadcast",
  );
}

export async function unpublishRoundFinalists(input: unknown): Promise<ActionResult> {
  return run(input, (ctx, fields) => rounds.unpublishFinalists(ctx, fields.roundId));
}

/** One round's advanced projects for the Rounds tab (read-only). */
export async function loadRoundFinalistsList(input: unknown): Promise<ActionResult<rounds.RoundFinalistDto[]>> {
  const gate = await roundsGate(input, "search");
  if (!gate.ok) return gate;
  const finalists = await rounds.loadRoundFinalists(gate.ctx, gate.input.roundId);
  if (!finalists) return { ok: false, error: "Judging round not found." };
  return { ok: true, data: finalists };
}
