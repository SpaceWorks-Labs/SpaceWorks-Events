import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { type Event } from "@prisma/client";
import { prisma } from "@/lib/db";
import { applyAssignments, assignMentorManually, previewAssignments, transitionAssignment } from "@/lib/core/mentorDesk/assignments";
import { saveMentoringRound, setRoundMentorPool } from "@/lib/core/mentorDesk/rounds";
import { conflictKeysFor } from "@/lib/core/judging";
import { createTeam, joinTeam, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { addMentor, createDeskEvent, goLive, HOUR, local, organiserOf } from "./helpers/mentorDesk";

// docs/MENTOR_DESK.md "Tests": assignment runs, seeded RANDOM, per-round pools and fresh eyes across stages.
describe.sequential("mentor desk assignments", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(tearDownJudgingSuite);

  async function withTeams(count: number) {
    let event = await createDeskEvent();
    const teamIds: string[] = [];
    for (let i = 0; i < count; i += 1) teamIds.push((await createTeam(event, `T${i} ${Math.random().toString(36).slice(2, 7)}`)).teamId);
    event = await goLive(event);
    return { event, teamIds, organiser: await organiserOf(event) };
  }

  async function round(event: Event, label: string, extra: Record<string, unknown> = {}) {
    const result = await saveMentoringRound(await organiserOf(event), { expectedVersion: 0, label, opensAt: local(new Date(Date.now() - 30 * 60_000)), closesAt: local(new Date(Date.now() + HOUR)), formSchema: [], ...extra });
    if (!result.ok) throw new Error(result.error);
    return result.data.id;
  }

  it("previews without writing, and a seeded RANDOM run is reproducible and differs across seeds", async () => {
    const { event, organiser } = await withTeams(6);
    for (const label of ["r1", "r2", "r3"]) await addMentor(event, label, { maxActiveTeams: 6 });
    const a = await previewAssignments(organiser, { mode: "RANDOM", seed: "a".repeat(32) });
    const again = await previewAssignments(organiser, { mode: "RANDOM", seed: "a".repeat(32) });
    if (!a.ok || !again.ok) throw new Error("preview failed");
    expect(again.data.assignments).toEqual(a.data.assignments);
    expect(again.data.fingerprint).toBe(a.data.fingerprint);
    const seeds = ["b", "c", "d", "e", "f"].map((c) => c.repeat(32));
    const others = await Promise.all(seeds.map((seed) => previewAssignments(organiser, { mode: "RANDOM", seed })));
    expect(others.some((o) => o.ok && JSON.stringify(o.data.assignments) !== JSON.stringify(a.data.assignments))).toBe(true);
    const fresh = await previewAssignments(organiser, { mode: "RANDOM" });
    expect(fresh.ok && fresh.data.seed).toMatch(/^[a-f0-9]{32}$/);
    expect(await prisma.mentorTeamAssignment.count({ where: { eventId: event.id } })).toBe(0);
    expect(await prisma.mentorAssignmentRun.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("applies a run with its seed and uncovered teams, never past capacity or into a conflict", async () => {
    const { event, organiser, teamIds } = await withTeams(5);
    const small = await addMentor(event, "small", { maxActiveTeams: 1 });
    const busy = await addMentor(event, "busy", { maxActiveTeams: 2 });
    await prisma.mentorConflict.create({ data: { eventId: event.id, mentorUserId: busy.userId, teamId: teamIds[0]!, kind: "AFFILIATION" } });
    await joinTeam(event, teamIds[1]!, { userId: small.userId });
    const preview = await previewAssignments(organiser, { mode: "RANDOM", seed: "1".repeat(32) });
    if (!preview.ok) throw new Error(preview.error);
    for (const row of preview.data.assignments) {
      expect(!(row.mentorUserId === busy.userId && row.teamId === teamIds[0])).toBe(true);
      expect(!(row.mentorUserId === small.userId && row.teamId === teamIds[1])).toBe(true);
    }
    expect(preview.data.assignments).toHaveLength(3);
    expect(preview.data.uncovered).toHaveLength(2);
    // A changed input makes the previewed fingerprint stale.
    await prisma.mentorProfile.updateMany({ where: { eventId: event.id, userId: busy.userId }, data: { maxActiveTeams: 3 } });
    expect(await applyAssignments(organiser, { mode: "RANDOM", seed: preview.data.seed, fingerprint: preview.data.fingerprint })).toEqual({ ok: false, error: "The mentors or teams changed; refresh the preview." });
    const next = await previewAssignments(organiser, { mode: "RANDOM", seed: preview.data.seed! });
    if (!next.ok) throw new Error(next.error);
    const applied = await applyAssignments(organiser, { mode: "RANDOM", seed: next.data.seed, fingerprint: next.data.fingerprint });
    expect(applied).toMatchObject({ ok: true, data: { created: 4, uncovered: 1 } });
    const run = await prisma.mentorAssignmentRun.findFirstOrThrow({ where: { eventId: event.id } });
    expect(run).toMatchObject({ mode: "RANDOM", seed: next.data.seed, inputFingerprint: next.data.fingerprint });
    expect(run.uncoveredTeamIds).toHaveLength(1);
    expect(await prisma.outboxMessage.count({ where: { kind: "mentor-assigned", payload: { path: ["id"], equals: (await prisma.mentorTeamAssignment.findFirstOrThrow({ where: { runId: run.id } })).id } } })).toBe(1);
    await expect(prisma.mentorAssignmentRun.update({ where: { id: run.id }, data: { mode: "MANUAL" } })).rejects.toThrow(/append-only/);
  });

  it("rechecks capacity on activation and records hand edits as overrides", async () => {
    const { event, organiser, teamIds } = await withTeams(3);
    const mentor = await addMentor(event, "cap", { maxActiveTeams: 1 });
    const preview = await previewAssignments(organiser, { mode: "ROUND_ROBIN" });
    if (!preview.ok) throw new Error(preview.error);
    await applyAssignments(organiser, { mode: "ROUND_ROBIN", fingerprint: preview.data.fingerprint, proposed: true });
    const proposed = await prisma.mentorTeamAssignment.findFirstOrThrow({ where: { eventId: event.id, status: "PROPOSED" } });
    expect(await assignMentorManually(organiser, { mentorUserId: mentor.userId, teamId: teamIds[2]! })).toEqual({ ok: false, error: "This mentor is at capacity." });
    expect((await transitionAssignment(organiser, { assignmentId: proposed.id, action: "activate", expectedVersion: proposed.version })).ok).toBe(true);
    await transitionAssignment(organiser, { assignmentId: proposed.id, action: "end", expectedVersion: proposed.version + 1 });
    expect((await assignMentorManually(organiser, { mentorUserId: mentor.userId, teamId: teamIds[2]! })).ok).toBe(true);
    expect(await prisma.mentorTeamAssignment.findFirstOrThrow({ where: { eventId: event.id, teamId: teamIds[2]!, endedAt: null } })).toMatchObject({ manualOverride: true, mode: "MANUAL" });
  });

  it("isolates rounds by their pools and applies fresh eyes across stages", async () => {
    const { event, organiser, teamIds } = await withTeams(2);
    const [m1, m2, m3] = [await addMentor(event, "p1"), await addMentor(event, "p2"), await addMentor(event, "p3")];
    const r1 = await round(event, "Stage 1");
    const r2 = await round(event, "Stage 2", { freshEyesAcrossStages: true });
    expect((await setRoundMentorPool(organiser, { roundId: r1, mentorUserIds: [m1.userId] })).ok).toBe(true);
    expect((await setRoundMentorPool(organiser, { roundId: r2, mentorUserIds: [m1.userId, m2.userId] })).ok).toBe(true);
    const p1 = await previewAssignments(organiser, { mode: "SKILL_MATCH", roundId: r1 });
    if (!p1.ok) throw new Error(p1.error);
    expect(new Set(p1.data.assignments.map((a) => a.mentorUserId))).toEqual(new Set([m1.userId]));
    await applyAssignments(organiser, { mode: "SKILL_MATCH", roundId: r1, fingerprint: p1.data.fingerprint });
    // Stage 2: m1 mentored both teams in stage 1, so the hard rule leaves them to m2; m3 is outside the pool.
    const p2 = await previewAssignments(organiser, { mode: "RANDOM", roundId: r2, seed: "9".repeat(32) });
    if (!p2.ok) throw new Error(p2.error);
    expect(p2.data.assignments.map((a) => a.mentorUserId)).toEqual([m2.userId, m2.userId]);
    expect(p2.data.assignments.some((a) => a.mentorUserId === m3.userId)).toBe(false);
    // Without the hard rule the earlier mentor is only avoided where possible.
    await prisma.mentoringRound.update({ where: { id: r2 }, data: { freshEyesAcrossStages: false } });
    const soft = await previewAssignments(organiser, { mode: "SKILL_MATCH", roundId: r2 });
    if (!soft.ok) throw new Error(soft.error);
    expect(soft.data.assignments.filter((a) => a.mentorUserId === m2.userId).length).toBeGreaterThanOrEqual(1);
    // An empty pool means every eligible mentor.
    await setRoundMentorPool(organiser, { roundId: r2, mentorUserIds: [] });
    const all = await previewAssignments(organiser, { mode: "ROUND_ROBIN", roundId: r2 });
    expect(all.ok && all.data.assignments.length).toBe(2);
    expect(teamIds).toHaveLength(2);
  });

  it("makes a mentored team a judging conflict only while the desk is on", async () => {
    const { event, teamIds } = await withTeams(1);
    const mentor = await addMentor(event, "judge-mentor");
    await prisma.mentorTeamAssignment.create({ data: { eventId: event.id, mentorUserId: mentor.userId, teamId: teamIds[0]!, mode: "MANUAL", status: "ENDED", activatedAt: new Date(), endedAt: new Date() } });
    expect((await conflictKeysFor(prisma, event.id, [mentor.userId])).get(mentor.userId)?.teamIds.has(teamIds[0]!)).toBe(true);
    await prisma.event.update({ where: { id: event.id }, data: { mentorDeskEnabled: false } });
    expect((await conflictKeysFor(prisma, event.id, [mentor.userId])).get(mentor.userId)?.teamIds.has(teamIds[0]!)).toBe(false);
  });
});
