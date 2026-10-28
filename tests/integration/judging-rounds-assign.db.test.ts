import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { assignJudge, createJudgingCriterion, listSubmissionsForJudge, setJudgingStatus, unassignJudge } from "@/lib/core/judging";
import { applyAutoAssignment, previewAutoAssignment } from "@/lib/core/judgingOps";
import { applyAdvancement, previewAdvancement, setJudgingRoundPanel, setJudgingRoundStatus, updateJudgingRound } from "@/lib/core/judgingRounds";
import { createEvent, grantJudges, judge, must, organiser, project, setUpRounds, tearDownRounds, twoRoundEvent, users } from "./helpers/judgingRounds";

/*
 * Assignment in rounds (docs/HACKATHON.md "Rounds"): seeded RANDOM runs that
 * are reproducible and recorded, conflict-free and balanced; per-round panels
 * narrowing the pool; fresh eyes across rounds; manual changes audited
 * against the latest run.
 */

const pool = () => [users.j1, users.j2, users.j3, users.j4];
const options = (extra: Record<string, unknown> = {}) => ({ perProject: 2, mode: "replace", judgeUserIds: pool(), ...extra });

async function assignmentEvent() {
  const event = await createEvent();
  await grantJudges(event, ...pool());
  const ctx = await organiser(event);
  const projects = [];
  for (let index = 0; index < 8; index += 1) projects.push(await project(event, `Random ${index}`));
  // j1 registered an entrant of their own: a conflict of interest.
  projects.push(await project(event, "Own project", users.j1));
  must(await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 10 }));
  must(await setJudgingStatus(ctx, "OPEN"));
  return { event, ctx, projects };
}

describe.sequential("assignment in rounds", () => {
  beforeAll(setUpRounds);
  afterAll(tearDownRounds);

  it("draws a seed for a random preview, reproduces it, and records the applied run", async () => {
    const { event, ctx, projects } = await assignmentEvent();
    const first = must(await previewAutoAssignment(ctx, options({ strategy: "random" })));
    expect(first.strategy).toBe("random");
    expect(first.seed).toMatch(/^[0-9a-f]{32}$/);
    const again = must(await previewAutoAssignment(ctx, options({ strategy: "random", seed: first.seed })));
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(again.inputFingerprint).toBe(first.inputFingerprint);
    const reroll = must(await previewAutoAssignment(ctx, options({ strategy: "random" })));
    expect(reroll.seed).not.toBe(first.seed);
    expect(await applyAutoAssignment(ctx, options({ strategy: "random", fingerprint: first.fingerprint }))).toMatchObject({ ok: false });
    const applied = must(await applyAutoAssignment(ctx, options({ strategy: "random", seed: first.seed, fingerprint: first.fingerprint })));
    expect(applied.seed).toBe(first.seed);
    const run = await prisma.judgingAssignmentRun.findUniqueOrThrow({ where: { id: applied.runId } });
    expect(run).toMatchObject({ strategy: "RANDOM", mode: "replace", seed: first.seed, perProject: 2, inputFingerprint: first.inputFingerprint, planFingerprint: first.fingerprint, createdByUserId: users.owner });
    const assignments = await prisma.judgeAssignment.findMany({ where: { eventId: event.id } });
    expect(assignments.some((row) => row.judgeUserId === users.j1 && row.submissionId === projects[8]!.id)).toBe(false);
    for (const item of projects) expect(assignments.filter((row) => row.submissionId === item.id)).toHaveLength(2);
    const loads = pool().map((id) => assignments.filter((row) => row.judgeUserId === id).length);
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
    // A BALANCED run records no seed (a CHECK keeps seeds to RANDOM runs).
    const balanced = must(await previewAutoAssignment(ctx, options()));
    expect(balanced.seed).toBeNull();
    await expect(prisma.judgingAssignmentRun.create({ data: { roundId: run.roundId, strategy: "BALANCED", mode: "keep", seed: first.seed, perProject: 2, judges: 1, added: 0, removed: 0, adopted: 0, inputFingerprint: "x", planFingerprint: "y" } })).rejects.toThrow();
  });

  it("audits manual changes after a run, naming the run", async () => {
    const { ctx, projects } = await assignmentEvent();
    const preview = must(await previewAutoAssignment(ctx, options({ strategy: "random" })));
    const applied = must(await applyAutoAssignment(ctx, options({ strategy: "random", seed: preview.seed, fingerprint: preview.fingerprint })));
    const assigned = await prisma.judgeAssignment.findFirstOrThrow({ where: { submissionId: projects[0]!.id } });
    must(await unassignJudge(ctx, { judgeUserId: assigned.judgeUserId, submissionId: projects[0]!.id }));
    must(await assignJudge(ctx, { judgeUserId: assigned.judgeUserId, submissionId: projects[0]!.id }));
    const audits = await prisma.auditEvent.findMany({ where: { targetId: ctx.eventId, action: { in: ["JUDGE_ASSIGNED", "JUDGE_UNASSIGNED"] } }, orderBy: { createdAt: "asc" } });
    expect(audits.map((row) => row.action)).toEqual(["JUDGE_UNASSIGNED", "JUDGE_ASSIGNED"]);
    expect(audits[0]!.metadata).toMatchObject({ afterRun: applied.runId, submissionId: projects[0]!.id });
  });

  it("narrows the automatic pool to the round's panel", async () => {
    const { ctx } = await assignmentEvent();
    const round = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: ctx.eventId } });
    must(await setJudgingRoundPanel(ctx, round.id, [users.j2, users.j3]));
    expect(await previewAutoAssignment(ctx, options())).toMatchObject({ ok: false, error: expect.stringContaining("can no longer judge") });
    const preview = must(await previewAutoAssignment(ctx, options({ judgeUserIds: [users.j2, users.j3] })));
    expect(preview.judges.map((row) => row.userId).sort()).toEqual([users.j2, users.j3].sort());
    expect(await assignJudge(ctx, { judgeUserId: users.j4, submissionId: (await prisma.submission.findFirstOrThrow({ where: { eventId: ctx.eventId } })).id })).toMatchObject({ ok: false });
  });

  it("keeps fresh eyes: no judge sees or gets a project they reviewed in an earlier round", async () => {
    const { event, ctx, projects, roundTwoId } = await twoRoundEvent([9, 7, 5]);
    const preview = must(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 2 }));
    must(await applyAdvancement(ctx, roundTwoId, { mode: "top", count: 2, fingerprint: preview.fingerprint }));
    must(await updateJudgingRound(ctx, roundTwoId, { name: "Finals", entrySource: "ADVANCED", judgesSeeAll: true, freshEyes: true, reviewsPerProject: "", scoreNormalization: "RAW", opensAt: "", closesAt: "" }));
    must(await setJudgingRoundStatus(ctx, roundTwoId, "OPEN"));
    // j1 and j2 reviewed every project in round 1; j3 did not.
    expect((await listSubmissionsForJudge(await judge(event, users.j1)))?.counts.all).toBe(0);
    expect((await listSubmissionsForJudge(await judge(event, users.j3)))?.counts.all).toBe(2);
    expect(await assignJudge(ctx, { judgeUserId: users.j1, submissionId: projects[0]!.id })).toMatchObject({ ok: false, error: expect.stringContaining("fresh eyes") });
    const auto = must(await previewAutoAssignment(ctx, { perProject: 1, mode: "keep", judgeUserIds: [users.j1, users.j2, users.j3] }));
    expect(auto.judges.find((row) => row.userId === users.j3)?.added).toBe(2);
    expect(auto.judges.filter((row) => row.userId !== users.j3).every((row) => row.added === 0)).toBe(true);
    // Fresh eyes is fixed once the round has opened.
    expect(await updateJudgingRound(ctx, roundTwoId, { name: "Finals", entrySource: "ADVANCED", judgesSeeAll: true, freshEyes: false, reviewsPerProject: "", scoreNormalization: "RAW", opensAt: "", closesAt: "" })).toMatchObject({ ok: false, fieldErrors: { freshEyes: [expect.any(String)] } });
    expect((await listSubmissionsForJudge(await judge(event, users.j1)))?.counts.all).toBe(0);
  });
});
