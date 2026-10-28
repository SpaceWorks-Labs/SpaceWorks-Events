import { createHash } from "node:crypto";

/*
 * Finalist advancement between judging rounds (docs/HACKATHON.md "Rounds"),
 * as pure functions. The caller passes the previous round's ranking (its
 * SUBMITTED projects in rank order, unscored ones last) and the projects
 * already advanced into the next round; the plan says who advances.
 *
 * - **Top N**: the first N *scored* projects in ranking order (ties keep the
 *   ranking's own order: submission time, then id). When the project just
 *   below the cut shares the last finalist's score, `tieAtCutoff` is set so
 *   the organiser can hand-pick instead. Unscored projects never advance by
 *   rank.
 * - **Hand-picked**: exactly the ids given, each of which must be in the
 *   ranking (a SUBMITTED project of the previous round); anything else is
 *   reported in `rejected` and the plan is refused.
 *
 * Disqualified and withdrawn projects are never in the ranking, so they can
 * never advance. The fingerprint covers the target, the chosen ids with their
 * source ranks, and what is already there, so applying refuses a plan that
 * changed since its preview.
 */

export type RankedProject = { submissionId: string; rank: number | null; score: number | null };

export type AdvancementRequest = { mode: "top"; count: number } | { mode: "pick"; submissionIds: readonly string[] };

export type AdvancementPlan = {
  /** Finalists in ranking order, with their rank in the previous round. */
  chosen: Array<{ submissionId: string; sourceRank: number | null }>;
  /** Already in the next round and staying. */
  kept: number;
  /** Newly advanced. */
  added: string[];
  /** In the next round now and dropped by this plan. */
  removed: string[];
  /** Picked ids that are not SUBMITTED projects of the previous round. */
  rejected: string[];
  /** The next project below the cut has the same score as the last finalist. */
  tieAtCutoff: boolean;
  fingerprint: string;
};

export function planAdvancement(input: {
  targetRoundId: string;
  ranking: readonly RankedProject[];
  existing: readonly string[];
  request: AdvancementRequest;
}): AdvancementPlan {
  const { ranking, request } = input;
  let chosenRows: RankedProject[];
  let rejected: string[] = [];
  let tieAtCutoff = false;
  if (request.mode === "top") {
    const scored = ranking.filter((row) => row.score != null);
    chosenRows = scored.slice(0, Math.max(0, request.count));
    const last = chosenRows[chosenRows.length - 1];
    const next = scored[chosenRows.length];
    tieAtCutoff = Boolean(last && next && last.score === next.score);
  } else {
    const wanted = new Set(request.submissionIds);
    chosenRows = ranking.filter((row) => wanted.has(row.submissionId));
    const known = new Set(chosenRows.map((row) => row.submissionId));
    rejected = [...wanted].filter((id) => !known.has(id)).sort();
  }
  const chosen = chosenRows.map((row) => ({ submissionId: row.submissionId, sourceRank: row.rank }));
  const chosenIds = new Set(chosen.map((row) => row.submissionId));
  const existing = new Set(input.existing);
  const added = chosen.map((row) => row.submissionId).filter((id) => !existing.has(id));
  const removed = [...existing].filter((id) => !chosenIds.has(id)).sort();
  return {
    chosen,
    kept: chosen.length - added.length,
    added,
    removed,
    rejected,
    tieAtCutoff,
    fingerprint: advancementFingerprint(input.targetRoundId, chosen, [...existing]),
  };
}

export function advancementFingerprint(targetRoundId: string, chosen: ReadonlyArray<{ submissionId: string; sourceRank: number | null }>, existing: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(`advance:${targetRoundId}\n`);
  for (const row of [...chosen].sort((a, b) => (a.submissionId < b.submissionId ? -1 : a.submissionId > b.submissionId ? 1 : 0))) {
    hash.update(`+${row.submissionId}:${row.sourceRank ?? "-"}\n`);
  }
  for (const id of [...existing].sort()) hash.update(`=${id}\n`);
  return hash.digest("base64url").slice(0, 22);
}
