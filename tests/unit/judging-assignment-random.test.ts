import { describe, expect, it } from "vitest";
import { pairKey, planAutoAssignment, seededTie, type AutoAssignInput } from "@/lib/judgingAssignment";

// docs/HACKATHON.md "Rounds": RANDOM assignment runs are seeded, reproducible,
// and keep every BALANCED rule (conflicts, target, even loads).

const SEED_A = "0123456789abcdef0123456789abcdef";
const SEED_B = "fedcba9876543210fedcba9876543210";

function input(overrides: Partial<AutoAssignInput> = {}): AutoAssignInput {
  return {
    projectIds: Array.from({ length: 20 }, (_, index) => `p${String(index).padStart(2, "0")}`),
    poolJudgeIds: ["ja", "jb", "jc", "jd", "je"],
    perProject: 3,
    mode: "keep",
    existing: [],
    blocked: new Set([pairKey("ja", "p00"), pairKey("jb", "p00"), pairKey("jc", "p05")]),
    started: new Set(),
    canJudge: () => true,
    ...overrides,
  };
}

const pairs = (plan: ReturnType<typeof planAutoAssignment>) => plan.add.map((pair) => pairKey(pair.judgeUserId, pair.submissionId)).sort();

describe("seededTie", () => {
  it("is stable for a seed and differs across seeds", () => {
    expect(seededTie(SEED_A, "x")).toBe(seededTie(SEED_A, "x"));
    expect(seededTie(SEED_A, "x")).not.toBe(seededTie(SEED_B, "x"));
    expect(seededTie(SEED_A, "x")).not.toBe(seededTie(SEED_A, "y"));
  });
});

describe("planAutoAssignment with a seed (RANDOM)", () => {
  it("gives the same plan for the same seed and inputs", () => {
    const first = planAutoAssignment(input({ seed: SEED_A }));
    const second = planAutoAssignment(input({ seed: SEED_A, projectIds: [...input().projectIds].reverse(), poolJudgeIds: ["je", "jd", "jc", "jb", "ja"] }));
    expect(pairs(second)).toEqual(pairs(first));
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("gives a different plan for a different seed, and differs from BALANCED", () => {
    const a = planAutoAssignment(input({ seed: SEED_A }));
    const b = planAutoAssignment(input({ seed: SEED_B }));
    const balanced = planAutoAssignment(input());
    expect(pairs(a)).not.toEqual(pairs(b));
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(balanced.fingerprint);
  });

  it("never assigns a blocked pair, reaches the target where possible, and keeps loads even", () => {
    for (const seed of [SEED_A, SEED_B, "00000000000000000000000000000000", "ffffffffffffffffffffffffffffffff"]) {
      const plan = planAutoAssignment(input({ seed }));
      const blocked = input().blocked;
      expect(plan.add.some((pair) => blocked.has(pairKey(pair.judgeUserId, pair.submissionId)))).toBe(false);
      expect(plan.shortfalls).toEqual([]);
      expect(plan.covered).toBe(20);
      for (const project of input().projectIds) expect(plan.add.filter((pair) => pair.submissionId === project)).toHaveLength(3);
      const loads = plan.loads.map((load) => load.after);
      expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
    }
  });

  it("reports the same shortfalls as BALANCED when judges run out", () => {
    const tight = { poolJudgeIds: ["ja", "jb"], perProject: 3 };
    const random = planAutoAssignment(input({ ...tight, seed: SEED_A }));
    const balanced = planAutoAssignment(input(tight));
    expect(random.shortfalls.map((row) => [row.submissionId, row.missing])).toEqual(balanced.shortfalls.map((row) => [row.submissionId, row.missing]));
  });
});
