import { JudgingStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { assignJudge, createJudgingCriterion, listSubmissionsForJudge, loadSubmissionForJudge, saveJudgeScores, setJudgeRecusal, setJudgingStatus } from "@/lib/core/judging";
import { loadJudgingProgress } from "@/lib/core/judgingOps";
import { createEvent, grantJudges, judge, must, organiser, project, review, setUpRounds, tearDownRounds, users } from "./helpers/judgingRounds";

/*
 * Judge self-recusal (docs/HACKATHON.md "Recusal"): only from a project
 * assigned in the open round and before a submitted review; the project
 * leaves the judge's list, can't be scored or reassigned to them, counts
 * like a missing review in Progress, and comes back on undo. Audited.
 */
describe.sequential("judge recusal", () => {
  beforeAll(setUpRounds);
  afterAll(tearDownRounds);

  it("lets an assigned judge step away from a project and back, within the rules", async () => {
    const event = await createEvent();
    await grantJudges(event, users.j1, users.j2);
    const ctx = await organiser(event);
    const impact = must(await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 10 }));
    const [first, second, third] = [await project(event, "First"), await project(event, "Second"), await project(event, "Third")];
    must(await setJudgingStatus(ctx, JudgingStatus.OPEN));
    await prisma.judgingRound.updateMany({ where: { eventId: event.id }, data: { judgesSeeAll: false } });
    for (const [judgeUserId, submissionId] of [[users.j1, first.id], [users.j1, second.id], [users.j2, first.id]] as const) {
      must(await assignJudge(ctx, { judgeUserId, submissionId }));
    }
    const j1 = await judge(event, users.j1);

    expect(must(await setJudgeRecusal(j1, { submissionId: first.id }, true))).toEqual({ recused: true });
    expect(must(await setJudgeRecusal(j1, { submissionId: first.id }, true))).toEqual({ recused: true });
    expect(await prisma.auditEvent.count({ where: { action: "JUDGE_RECUSED", targetId: first.id, actorUserId: users.j1 } })).toBe(1);
    const workspace = await listSubmissionsForJudge(j1);
    expect(workspace?.submissions.map((row) => row.id)).toEqual([second.id]);
    expect(workspace?.recusals).toEqual([{ submissionId: first.id, title: "First" }]);
    expect(await loadSubmissionForJudge(j1, first.id)).toBeNull();
    expect(await saveJudgeScores(j1, { submissionId: first.id, scores: [{ criterionId: impact.id, score: 5 }] })).toMatchObject({ ok: false, code: "NOT_VISIBLE" });
    expect(await loadSubmissionForJudge(j1, second.id)).toMatchObject({ canRecuse: true });

    // Organisers see it; it counts like a missing review and can't be reassigned to the same judge.
    const progress = await loadJudgingProgress(ctx);
    expect(progress?.judges.rows.find((row) => row.userId === users.j1)).toMatchObject({ assigned: 1, recused: 1 });
    expect(progress?.belowTarget.rows.find((row) => row.submissionId === first.id)).toMatchObject({ assigned: 1 });
    expect(await assignJudge(ctx, { judgeUserId: users.j1, submissionId: first.id })).toMatchObject({ ok: false, error: expect.stringContaining("recused") });

    // Not assigned, or already reviewed: refused.
    expect(await setJudgeRecusal(j1, { submissionId: third.id }, true)).toMatchObject({ ok: false, code: "NOT_VISIBLE" });
    await review(event, users.j2, first.id, impact.id, 6);
    const j2 = await judge(event, users.j2);
    expect(await loadSubmissionForJudge(j2, first.id)).toMatchObject({ canRecuse: false });
    expect(await setJudgeRecusal(j2, { submissionId: first.id }, true)).toMatchObject({ ok: false, error: expect.stringContaining("already submitted") });

    // Undo brings it back; once judging closes nothing changes.
    expect(must(await setJudgeRecusal(j1, { submissionId: first.id }, false))).toEqual({ recused: false });
    expect(await prisma.auditEvent.count({ where: { action: "JUDGE_RECUSAL_WITHDRAWN", targetId: first.id } })).toBe(1);
    expect((await listSubmissionsForJudge(j1))?.submissions.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
    must(await setJudgingStatus(ctx, JudgingStatus.CLOSED));
    expect(await setJudgeRecusal(j1, { submissionId: second.id }, true)).toMatchObject({ ok: false, code: "JUDGING_CLOSED" });
  });
});
