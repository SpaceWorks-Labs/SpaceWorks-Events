import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pairKey, planAutoAssignment, type AutoAssignInput } from "@/lib/judgingAssignment";

/*
 * The seeded planner moved to lib/assignmentPlanner.ts so admission review can
 * share it. Judging must plan exactly as before: these generated inputs were
 * planned by the pre-extraction lib/judgingAssignment.ts and the digest of
 * every plan is pinned below.
 */

function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generatedInputs(count: number): AutoAssignInput[] {
  const inputs: AutoAssignInput[] = [];
  for (let case_ = 0; case_ < count; case_ += 1) {
    const rand = prng(case_ + 1);
    const projects = Array.from({ length: 1 + Math.floor(rand() * 12) }, (_, i) => `p${case_}-${i}`);
    const judges = Array.from({ length: 1 + Math.floor(rand() * 7) }, (_, i) => `j${i}`);
    const pick = (p: number) => {
      const set = new Set<string>();
      for (const j of judges) for (const pr of projects) if (rand() < p) set.add(pairKey(j, pr));
      return set;
    };
    const existing = [...pick(0.15)].map((key) => {
      const [judgeUserId, submissionId] = key.split("\u0000") as [string, string];
      return { judgeUserId, submissionId };
    });
    const started = pick(0.1);
    const submitted = new Set([...started].filter(() => rand() < 0.5));
    const unable = new Set(judges.filter(() => rand() < 0.15));
    inputs.push({
      projectIds: projects,
      poolJudgeIds: judges.filter(() => rand() < 0.85),
      perProject: 1 + Math.floor(rand() * 4),
      mode: rand() < 0.5 ? "keep" : "replace",
      existing,
      blocked: pick(0.1),
      started,
      submitted,
      adoptStarted: rand() < 0.4,
      canJudge: (id) => !unable.has(id),
      seed: rand() < 0.5 ? createHash("md5").update(`seed${case_}`).digest("hex") : null,
    });
  }
  return inputs;
}

function digestPlans(plan: (input: AutoAssignInput) => unknown): string {
  const hash = createHash("sha256");
  for (const input of generatedInputs(400)) hash.update(JSON.stringify(plan(input)));
  return hash.digest("hex");
}

describe("shared assignment planner", () => {
  it("plans judging exactly as the pre-extraction judging planner", () => {
    expect(digestPlans(planAutoAssignment)).toBe("e78d35bf028d26f82454ba2b33e28030707a8d3b9f0d4546769255ce68e681fb");
  });
});
