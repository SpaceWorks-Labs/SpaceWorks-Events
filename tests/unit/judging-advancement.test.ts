import { describe, expect, it } from "vitest";
import { advancementFingerprint, planAdvancement, type RankedProject } from "@/lib/judgingAdvancement";

// docs/HACKATHON.md "Rounds": who advances from one round to the next.

const ranking: RankedProject[] = [
  { submissionId: "a", rank: 1, score: 90 },
  { submissionId: "b", rank: 2, score: 80 },
  { submissionId: "c", rank: 2, score: 80 },
  { submissionId: "d", rank: 4, score: 70 },
  { submissionId: "e", rank: null, score: null },
];

describe("planAdvancement", () => {
  it("takes the top N scored projects in ranking order with their source ranks", () => {
    const plan = planAdvancement({ targetRoundId: "r2", ranking, existing: [], request: { mode: "top", count: 2 } });
    expect(plan.chosen).toEqual([
      { submissionId: "a", sourceRank: 1 },
      { submissionId: "b", sourceRank: 2 },
    ]);
    expect(plan.added).toEqual(["a", "b"]);
    expect(plan.removed).toEqual([]);
    expect(plan.kept).toBe(0);
  });

  it("flags a tie at the cut so the organiser can pick by hand", () => {
    expect(planAdvancement({ targetRoundId: "r2", ranking, existing: [], request: { mode: "top", count: 2 } }).tieAtCutoff).toBe(true);
    expect(planAdvancement({ targetRoundId: "r2", ranking, existing: [], request: { mode: "top", count: 3 } }).tieAtCutoff).toBe(false);
    expect(planAdvancement({ targetRoundId: "r2", ranking, existing: [], request: { mode: "top", count: 1 } }).tieAtCutoff).toBe(false);
  });

  it("never advances unscored projects by rank, even when N exceeds the scored ones", () => {
    const plan = planAdvancement({ targetRoundId: "r2", ranking, existing: [], request: { mode: "top", count: 50 } });
    expect(plan.chosen.map((row) => row.submissionId)).toEqual(["a", "b", "c", "d"]);
  });

  it("hand-picks only projects in the ranking and reports anything else", () => {
    const plan = planAdvancement({ targetRoundId: "r2", ranking, existing: [], request: { mode: "pick", submissionIds: ["d", "e", "zz", "a"] } });
    expect(plan.chosen.map((row) => row.submissionId)).toEqual(["a", "d", "e"]);
    expect(plan.chosen.find((row) => row.submissionId === "e")?.sourceRank).toBeNull();
    expect(plan.rejected).toEqual(["zz"]);
  });

  it("diffs against the finalists already in the round", () => {
    const plan = planAdvancement({ targetRoundId: "r2", ranking, existing: ["b", "d"], request: { mode: "top", count: 2 } });
    expect(plan.added).toEqual(["a"]);
    expect(plan.removed).toEqual(["d"]);
    expect(plan.kept).toBe(1);
  });

  it("fingerprints the target, the choice with ranks, and what is there now", () => {
    const base = planAdvancement({ targetRoundId: "r2", ranking, existing: [], request: { mode: "top", count: 2 } }).fingerprint;
    expect(planAdvancement({ targetRoundId: "r2", ranking, existing: [], request: { mode: "pick", submissionIds: ["b", "a"] } }).fingerprint).toBe(base);
    expect(planAdvancement({ targetRoundId: "r3", ranking, existing: [], request: { mode: "top", count: 2 } }).fingerprint).not.toBe(base);
    expect(planAdvancement({ targetRoundId: "r2", ranking, existing: ["a"], request: { mode: "top", count: 2 } }).fingerprint).not.toBe(base);
    const reRanked = ranking.map((row) => (row.submissionId === "b" ? { ...row, rank: 3 } : row));
    expect(planAdvancement({ targetRoundId: "r2", ranking: reRanked, existing: [], request: { mode: "top", count: 2 } }).fingerprint).not.toBe(base);
    expect(advancementFingerprint("r2", [{ submissionId: "b", sourceRank: 2 }, { submissionId: "a", sourceRank: 1 }], [])).toBe(base);
  });
});
