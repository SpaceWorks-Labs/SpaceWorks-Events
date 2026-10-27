import { describe, expect, it } from "vitest";
import { allocate, seededRandom, seededShuffle, type AllocationCandidate } from "@/lib/mentorDesk/allocation";
import { claimLeaseExpiry, coversInterval, expiryAction, helpDeadline, helpExpiresAt, helpLiveness, inWindows, normaliseTags, parseAvailability, skillAndPriorityEligible, visitLeaseExpiry } from "@/lib/mentorDesk/rules";
import { firedTriggers, roundFormSchema, validateRoundAnswers, validateTriggerRules } from "@/lib/mentorDesk/roundForm";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 13, 12, 0) + minutes * 60_000);
const candidate = (id: string, extra: Partial<AllocationCandidate> = {}): AllocationCandidate => ({ id, skills: [], load: 0, capacity: 10, excludedTeamIds: new Set(), ...extra });
const teams = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${String(i).padStart(2, "0")}`, skills: [] as string[] }));

describe("help deadline and lease math", () => {
  it("never lets a request outlive the event", () => {
    expect(helpDeadline(at(60), at(30))).toEqual(at(30));
    expect(helpExpiresAt(at(0), 240, at(90))).toEqual(at(90));
    expect(helpExpiresAt(at(0), 15, at(90))).toEqual(at(15));
  });

  it("bounds a claim lease by the deadline", () => {
    expect(claimLeaseExpiry(at(0), 10, at(60))).toEqual(at(10));
    expect(claimLeaseExpiry(at(55), 10, at(60))).toEqual(at(60));
  });

  it("classifies liveness the way every command checks it", () => {
    const row = { status: "CLAIMED" as const, claimExpiresAt: at(5), expiresAt: at(60) };
    expect(helpLiveness(row, at(120), at(0))).toBe("ok");
    expect(helpLiveness(row, at(120), at(6))).toBe("lease-lost");
    expect(helpLiveness(row, at(120), at(61))).toBe("expired");
    expect(helpLiveness({ ...row, status: "OPEN", claimExpiresAt: null }, at(30), at(31))).toBe("expired");
  });

  it("tells the beat to expire, release or leave each row", () => {
    expect(expiryAction({ status: "CLAIMED", claimExpiresAt: at(5), expiresAt: at(60) }, at(120), at(6))).toBe("release");
    expect(expiryAction({ status: "CLAIMED", claimExpiresAt: at(5), expiresAt: at(60) }, at(120), at(61))).toBe("expire");
    expect(expiryAction({ status: "OPEN", claimExpiresAt: null, expiresAt: at(60) }, at(120), at(10))).toBeNull();
    expect(expiryAction({ status: "RESOLVED", claimExpiresAt: null, expiresAt: at(0) }, at(1), at(10))).toBeNull();
  });

  it("caps a visit lease at ten minutes and the round's close", () => {
    expect(visitLeaseExpiry(at(0), at(60))).toEqual(at(10));
    expect(visitLeaseExpiry(at(55), at(60))).toEqual(at(60));
  });
});

describe("availability windows", () => {
  const windows = parseAvailability([{ startsAt: at(0).toISOString(), endsAt: at(60).toISOString() }, { startsAt: "nope", endsAt: at(1).toISOString() }]);
  it("drops malformed windows and is half-open", () => {
    expect(windows).toHaveLength(1);
    expect(inWindows(windows, at(0))).toBe(true);
    expect(inWindows(windows, at(60))).toBe(false);
    expect(inWindows([], at(0))).toBe(false);
    expect(coversInterval(windows, at(10), at(60))).toBe(true);
    expect(coversInterval(windows, at(10), at(61))).toBe(false);
  });
});

describe("eligibility", () => {
  const base = { assignedToMentor: false, teamHasAssignedMentor: false, priorityUntil: null, now: at(0), mentorSkills: ["aws"], skillTags: [] as string[] };
  it("gives assigned mentors priority, then matches skills", () => {
    expect(skillAndPriorityEligible({ ...base, teamHasAssignedMentor: true, priorityUntil: at(5) })).toBe(false);
    expect(skillAndPriorityEligible({ ...base, teamHasAssignedMentor: true, priorityUntil: at(-1) })).toBe(true);
    expect(skillAndPriorityEligible({ ...base, assignedToMentor: true, skillTags: ["rust"] })).toBe(true);
    expect(skillAndPriorityEligible({ ...base, skillTags: ["rust"] })).toBe(false);
    expect(skillAndPriorityEligible({ ...base, skillTags: ["aws"] })).toBe(true);
  });
  it("normalises tags", () => {
    expect(normaliseTags([" AWS ", "aws", "Machine  Learning", ""])).toEqual(["aws", "machine learning"]);
  });
});

describe("allocation", () => {
  it("balances load deterministically in ROUND_ROBIN (load, then id)", () => {
    const result = allocate({ teams: teams(4), candidates: [candidate("b"), candidate("a", { load: 1 })], mode: "ROUND_ROBIN" });
    expect(result.assignments.map((a) => a.mentorUserId)).toEqual(["b", "a", "b", "a"]);
  });

  it("prefers skill overlap in SKILL_MATCH, then load, then id", () => {
    const result = allocate({ teams: [{ id: "t1", skills: ["ml"] }, { id: "t2", skills: ["web"] }], candidates: [candidate("a", { skills: ["web"] }), candidate("b", { skills: ["ml"] })], mode: "SKILL_MATCH" });
    expect(result.assignments).toEqual([{ teamId: "t1", mentorUserId: "b" }, { teamId: "t2", mentorUserId: "a" }]);
  });

  it("only takes the organiser's pick in MANUAL", () => {
    const result = allocate({ teams: teams(2), candidates: [candidate("a"), candidate("b")], mode: "MANUAL", manual: { t00: "b" } });
    expect(result).toEqual({ assignments: [{ teamId: "t00", mentorUserId: "b" }], uncoveredTeamIds: ["t01"] });
  });

  it("is reproducible for a RANDOM seed, differs across seeds, and ignores input order", () => {
    const mentors = ["m1", "m2", "m3", "m4", "m5"].map((id) => candidate(id, { capacity: 3 }));
    const run = (seed: string, list = mentors) => allocate({ teams: teams(12), candidates: list, mode: "RANDOM", seed }).assignments;
    expect(run("seed-1")).toEqual(run("seed-1"));
    expect(run("seed-1", [...mentors].reverse())).toEqual(run("seed-1"));
    const variants = new Set(["a", "b", "c", "d", "e", "f"].map((s) => JSON.stringify(run(s))));
    expect(variants.size).toBeGreaterThan(1);
    expect(() => allocate({ teams: teams(1), candidates: mentors, mode: "RANDOM" })).toThrow();
  });

  it("never breaks conflicts or capacity in any mode", () => {
    for (const mode of ["ROUND_ROBIN", "SKILL_MATCH", "RANDOM"] as const) {
      for (const seed of ["x", "y", "z"]) {
        const list = [candidate("a", { capacity: 2, excludedTeamIds: new Set(["t00", "t01"]) }), candidate("b", { capacity: 1 }), candidate("c", { capacity: 2, load: 1 })];
        const result = allocate({ teams: teams(6), candidates: list, mode, seed });
        const counts = new Map<string, number>();
        for (const a of result.assignments) counts.set(a.mentorUserId, (counts.get(a.mentorUserId) ?? 0) + 1);
        expect(result.assignments.some((a) => a.mentorUserId === "a" && ["t00", "t01"].includes(a.teamId))).toBe(false);
        expect(counts.get("a") ?? 0).toBeLessThanOrEqual(2);
        expect(counts.get("b") ?? 0).toBeLessThanOrEqual(1);
        expect(counts.get("c") ?? 0).toBeLessThanOrEqual(1);
        expect(result.assignments.length + result.uncoveredTeamIds.length).toBe(6);
      }
    }
  });

  it("avoids a team's earlier mentor where possible (soft fresh eyes)", () => {
    const result = allocate({ teams: teams(1), candidates: [candidate("a", { avoidTeamIds: new Set(["t00"]) }), candidate("b", { load: 3 })], mode: "RANDOM", seed: "s" });
    expect(result.assignments[0]!.mentorUserId).toBe("b");
    const only = allocate({ teams: teams(1), candidates: [candidate("a", { avoidTeamIds: new Set(["t00"]) })], mode: "SKILL_MATCH" });
    expect(only.assignments[0]!.mentorUserId).toBe("a");
  });

  it("seeds a stable PRNG and shuffle", () => {
    expect(seededRandom("abc")()).toBe(seededRandom("abc")());
    expect(seededShuffle([{ id: "c" }, { id: "a" }, { id: "b" }], "k")).toEqual(seededShuffle([{ id: "b" }, { id: "c" }, { id: "a" }], "k"));
  });
});

describe("round forms and triggers", () => {
  const form = roundFormSchema.parse([{ id: "stuck", label: "Stuck?", type: "yesno", required: true }, { id: "mood", label: "Mood", type: "rating" }, { id: "note", label: "Note", type: "text" }, { id: "stage", label: "Stage", type: "choice", options: ["idea", "build"] }]);
  it("validates answers by type and required questions", () => {
    expect(validateRoundAnswers(form, { stuck: false, mood: 4, stage: "build" })).toEqual({ stuck: false, mood: 4, stage: "build" });
    expect(validateRoundAnswers(form, { mood: 4 })).toBeNull();
    expect(validateRoundAnswers(form, { stuck: true, mood: 6 })).toBeNull();
    expect(validateRoundAnswers(form, { stuck: true, unknown: 1 })).toBeNull();
    expect(validateRoundAnswers(form, { stuck: true, stage: "ship" })).toBeNull();
  });
  it("checks trigger rules against questions and categories and fires them", () => {
    const rules = validateTriggerRules([{ key: "k", questionId: "stuck", op: "eq", value: true, categoryKey: "general" }, { key: "n", questionId: "note", op: "contains", value: "deploy", categoryKey: "general" }], form, new Set(["general"]));
    expect(rules).toHaveLength(2);
    expect(validateTriggerRules([{ key: "k", questionId: "missing", op: "eq", value: true, categoryKey: "general" }], form, new Set(["general"]))).toBeNull();
    expect(firedTriggers(rules!, { stuck: true, note: "Need DEPLOY help" }).map((r) => r.key)).toEqual(["k", "n"]);
    expect(firedTriggers(rules!, { stuck: false })).toEqual([]);
  });
});
