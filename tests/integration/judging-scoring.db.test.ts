import { JudgingStatus, SubmissionStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => vi.fn(async (): Promise<{ user: { id: string } } | null> => null));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { eventUsesJudging } from "@/lib/eventDashboard/judging";
import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import type { JudgeContext } from "@/lib/judgingAccess";
import { buildJudgingExportRows, createJudgingCriterion, disqualifySubmission, loadJudgeProgress, loadJudgingResults, reinstateSubmission, resolveEntrantForUser, saveJudgeScores, saveSubmissionDraft, setJudgingStatus, submitJudgeReview, submitSubmission, updateJudgingSettings, withdrawSubmission } from "@/lib/core/judging";
import { content, createEvent, createJudge, createTeam, createUser, criterion, joinTeam, openWindow, organiser, setUpJudgingSuite, submissionIdFor, suffix, tearDownJudgingSuite, teamAuth } from "./helpers/judging";

// docs/HACKATHON.md "Tests", scoring: judging status, concurrent writes, and the result formula. Shared setup: tests/integration/helpers/judging.ts.
describe.sequential("hackathon judging integration", () => {
  beforeAll(setUpJudgingSuite);

  afterAll(tearDownJudgingSuite);

  // -------------------------------------------------------------------------
  // Scoring
  // -------------------------------------------------------------------------

  it("refuses scores unless judging is open and the submission is submitted", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const judge = await createJudge(event);
    const { teamId } = await createTeam(event, `Scored ${suffix}`);
    const auth = await teamAuth(teamId);
    await submitSubmission(auth, content);
    const submissionId = await submissionIdFor({ teamId });
    const notOpen = { ok: false, error: "Judging is not open." };

    // Opening needs a rubric.
    expect(await setJudgingStatus(ctx, JudgingStatus.OPEN)).toMatchObject({ ok: false });
    const c = await criterion(ctx, { name: "Impact", weight: 1, maxScore: 5 });
    const score = (value: number) => saveJudgeScores(judge.ctx, { submissionId, scores: [{ criterionId: c, score: value }] });

    // NOT_STARTED.
    expect(await score(3)).toMatchObject(notOpen);
    expect(await submitJudgeReview(judge.ctx, { submissionId, comment: "Early" })).toMatchObject(notOpen);
    expect(await setJudgingStatus(ctx, JudgingStatus.CLOSED)).toMatchObject({ ok: false });

    // OPEN: the rubric freezes; scores must fit the criterion.
    expect(await setJudgingStatus(ctx, JudgingStatus.OPEN)).toMatchObject({ ok: true, data: { judgingStatus: JudgingStatus.OPEN } });
    expect(await createJudgingCriterion(ctx, { name: "Late", weight: 1, maxScore: 5 })).toMatchObject({ ok: false, error: "The rubric can only be changed before judging starts." });
    expect(await score(6)).toMatchObject({ ok: false });
    expect(await saveJudgeScores(judge.ctx, { submissionId, scores: [{ criterionId: c, score: -1 }] })).toMatchObject({ ok: false });
    expect(await saveJudgeScores(judge.ctx, { submissionId, scores: [{ criterionId: c, score: 2.5 }] })).toMatchObject({ ok: false });
    expect(await score(3)).toEqual({ ok: true, data: { scored: 1, total: 1 } });

    // Drafts and withdrawn projects are not judged.
    expect(await withdrawSubmission(auth)).toMatchObject({ ok: true });
    expect(await score(4)).toMatchObject({ ok: false, error: "Submission not found." });
    expect(await saveSubmissionDraft(auth, content)).toMatchObject({ ok: true, data: { status: SubmissionStatus.DRAFT } });
    expect(await score(4)).toMatchObject({ ok: false });
    expect(await submitSubmission(auth, content)).toMatchObject({ ok: true });
    expect(await score(4)).toMatchObject({ ok: true });

    // Disqualified projects are not judged either; reinstating restores them.
    expect(await disqualifySubmission(ctx, { submissionId, reason: "Copied" })).toMatchObject({ ok: true });
    expect(await score(5)).toMatchObject({ ok: false });
    expect(await reinstateSubmission(ctx, submissionId)).toMatchObject({ ok: true });
    expect(await submitJudgeReview(judge.ctx, { submissionId, comment: "Good" })).toEqual({ ok: true, data: { submitted: true } });

    // CLOSED freezes everything.
    expect(await setJudgingStatus(ctx, JudgingStatus.CLOSED)).toMatchObject({ ok: true });
    expect(await score(1)).toMatchObject(notOpen);
    expect(await submitJudgeReview(judge.ctx, { submissionId, comment: "Changed my mind" })).toMatchObject(notOpen);
    expect(await prisma.judgeScore.findFirstOrThrow({ where: { submissionId, judgeUserId: judge.userId } })).toMatchObject({ score: 4 });
    // Once scored, judging cannot go back to NOT_STARTED.
    expect(await setJudgingStatus(ctx, JudgingStatus.NOT_STARTED)).toMatchObject({ ok: false });
    expect(await prisma.auditEvent.count({ where: { action: "JUDGING_STATUS_CHANGED", targetId: event.id } })).toBe(2);
    expect(await prisma.auditEvent.count({ where: { action: { in: ["SUBMISSION_DISQUALIFIED", "SUBMISSION_REINSTATED"] }, targetId: submissionId } })).toBe(2);
    // The organiser-only reason never reaches the audit metadata.
    expect(JSON.stringify(await prisma.auditEvent.findMany({ where: { targetId: submissionId } }))).not.toContain("Copied");
  });

  it("keeps concurrent score, review, and submission writes unique", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const { teamId } = await createTeam(event, `Race ${suffix}`);
    const memberUser = await createUser("racer");
    await joinTeam(event, teamId, { userId: memberUser.id });
    const leaderAuth = await teamAuth(teamId);
    const memberAuth = await resolveEntrantForUser(memberUser.id, event.id);
    if (!memberAuth) throw new Error("member entrant missing");

    // Two people save the team's first draft at once: one row.
    const saves = await Promise.all([
      saveSubmissionDraft(leaderAuth, { title: "Leader" }),
      saveSubmissionDraft(memberAuth, { title: "Member" }),
      submitSubmission(leaderAuth, { title: "Leader submit" }),
      submitSubmission(memberAuth, { title: "Member submit" }),
    ]);
    expect(saves.some((save) => save.ok)).toBe(true);
    for (const save of saves) if (!save.ok) expect(save.error).toBe("This was changed by someone else. Refresh and try again.");
    expect(await prisma.submission.count({ where: { teamId } })).toBe(1);
    await submitSubmission(leaderAuth, content);
    const submissionId = await submissionIdFor({ teamId });
    const receipts = () => prisma.outboxMessage.count({ where: { kind: "submission-received", payload: { path: ["submissionId"], equals: submissionId } } });
    expect(await receipts()).toBe(1);
    // Concurrent submits of one existing draft: one transition, one receipt.
    expect(await withdrawSubmission(leaderAuth)).toMatchObject({ ok: true });
    expect(await saveSubmissionDraft(memberAuth, content)).toMatchObject({ ok: true, data: { status: SubmissionStatus.DRAFT } });
    const resubmits = await Promise.all([leaderAuth, memberAuth, leaderAuth, memberAuth].map((auth) => submitSubmission(auth, content)));
    expect(resubmits.every((result) => result.ok)).toBe(true);
    expect(await receipts()).toBe(2);

    const [first, second] = [await createJudge(event, "racer-a"), await createJudge(event, "racer-b")];
    const criteria = [await criterion(ctx, { name: "A", weight: 1, maxScore: 10 }), await criterion(ctx, { name: "B", weight: 2, maxScore: 10 })];
    await setJudgingStatus(ctx, JudgingStatus.OPEN);

    const writes = await Promise.all(
      [first, second].flatMap((judge) => [1, 2, 3, 4, 5, 6].map((value) => saveJudgeScores(judge.ctx, {
        submissionId,
        scores: criteria.map((criterionId) => ({ criterionId, score: value })),
      }))),
    );
    expect(writes.every((write) => write.ok)).toBe(true);
    expect(await prisma.judgeScore.count({ where: { submissionId } })).toBe(4);

    const reviews = await Promise.all([first, second].flatMap((judge) => [true, false, true].map((submit, index) => submitJudgeReview(judge.ctx, { submissionId, comment: `Take ${index}`, submit }))));
    expect(reviews.every((review) => review.ok)).toBe(true);
    expect(await prisma.judgeReview.count({ where: { submissionId } })).toBe(2);
    // A later draft save never un-submits a submitted review.
    expect(await prisma.judgeReview.count({ where: { submissionId, submittedAt: null } })).toBe(0);
  });

  it("computes the result score formula with shared tie ranks", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const teams = await Promise.all(["One", "Two", "Three", "Four"].map((name) => createTeam(event, `${name} ${suffix}`)));
    for (const team of teams) expect(await submitSubmission(await teamAuth(team.teamId), { title: `Project ${team.teamId.slice(-4)}` })).toMatchObject({ ok: true });
    const [s1, s2, s3, s4] = await Promise.all(teams.map((team) => submissionIdFor({ teamId: team.teamId })));

    const design = await criterion(ctx, { name: "Design", weight: 2, maxScore: 5 });
    const impact = await criterion(ctx, { name: "Impact", weight: 1, maxScore: 10 });
    const [j1, j2, j3] = [await createJudge(event, "j1"), await createJudge(event, "j2"), await createJudge(event, "j3")];
    await setJudgingStatus(ctx, JudgingStatus.OPEN);

    async function review(judge: JudgeContext, submissionId: string, designScore: number, impactScore: number, submit = true) {
      expect(await saveJudgeScores(judge, { submissionId, scores: [{ criterionId: design, score: designScore }, { criterionId: impact, score: impactScore }] })).toMatchObject({ ok: true });
      expect(await submitJudgeReview(judge, { submissionId, comment: "Private note", submit })).toMatchObject({ ok: true, data: { submitted: submit } });
    }

    // Σ(weight × score / maxScore) / Σ weight × 100, averaged over submitted reviews.
    // S1: J1 (5, 10) = 100; J2 (3, 4) = (1.2 + 0.4) / 3 = 53.33…; mean 76.67 -> 76.7.
    //     J3 saved scores but never submitted: not counted.
    await review(j1.ctx, s1, 5, 10);
    await review(j2.ctx, s1, 3, 4);
    await review(j3.ctx, s1, 0, 0, false);
    // S2: J1 (4, 8) = (1.6 + 0.8) / 3 = 80.
    await review(j1.ctx, s2, 4, 8);
    // S3: J2 (5, 4) = (2 + 0.4) / 3 = 80 — a tie with S2.
    await review(j2.ctx, s3, 5, 4);
    // S4: partial scores only; a submitted review needs every criterion.
    expect(await saveJudgeScores(j3.ctx, { submissionId: s4, scores: [{ criterionId: design, score: 5 }] })).toEqual({ ok: true, data: { scored: 1, total: 2 } });
    expect(await submitJudgeReview(j3.ctx, { submissionId: s4 })).toMatchObject({ ok: false, error: "Score every criterion before submitting your review." });

    const results = await loadJudgingResults(ctx);
    const row = (id: string) => results?.rows.find((r) => r.submissionId === id);
    expect(results?.rows.map((r) => [r.submissionId, r.score, r.rank, r.judgesCounted])).toEqual([
      [s2, 80, 1, 1],
      [s3, 80, 1, 1],
      [s1, 76.7, 3, 2],
      [s4, null, null, 0],
    ]);
    expect(row(s1)?.criterionAverages).toEqual([{ criterionId: design, average: 4 }, { criterionId: impact, average: 7 }]);
    const progress = await loadJudgeProgress(ctx);
    expect(progress?.find((j) => j.userId === j1.userId)).toMatchObject({ visible: 4, reviewsSubmitted: 2 });
    expect(progress?.find((j) => j.userId === j3.userId)).toMatchObject({ reviewsSubmitted: 0 });

    // The CSV rows carry the result and per-judge scores, never comments or emails.
    const csv = await buildJudgingExportRows(ctx);
    expect(csv?.[0]).toEqual(["Rank", "Project", "Entrant", "Status", "Result score", "Raw score", "Adjusted score", "Judges counted", "Judge", "Review submitted (UTC)", "Counted in score", "Design (/5, weight 2)", "Impact (/10, weight 1)"]);
    expect(csv?.filter((line) => line[4] === "76.7")).toHaveLength(3);
    expect(JSON.stringify(csv)).not.toMatch(/Private note|@example\.test/);
    // Review times use the event's clock, as ISO 8601 with the offset, like the dashboard.
    expect(csv?.slice(1).filter((line) => line[9]).every((line) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(line[9]!))).toBe(true);
    await prisma.event.update({ where: { id: event.id }, data: { timezone: "Asia/Kolkata" } });
    const zoned = await buildJudgingExportRows(ctx);
    expect(zoned?.[0]?.[9]).toBe("Review submitted (Asia/Kolkata)");
    const stamped = zoned?.slice(1).map((line) => line[9]).filter(Boolean) ?? [];
    expect(stamped.length).toBeGreaterThan(0);
    for (const stamp of stamped) {
      expect(stamp).toMatch(/\+05:30$/);
      // Same instant as the stored review time.
      expect(Number.isNaN(new Date(stamp!).getTime())).toBe(false);
    }
    const stored = await prisma.judgeReview.findMany({ where: { submission: { eventId: event.id }, submittedAt: { not: null } }, select: { submittedAt: true } });
    const instants = new Set(stored.map((review) => Math.floor(review.submittedAt!.getTime() / 1000)));
    expect(stamped.every((stamp) => instants.has(new Date(stamp!).getTime() / 1000))).toBe(true);

    // A disqualified project drops out of the ranking; the rest re-rank.
    expect(await disqualifySubmission(ctx, { submissionId: s2, reason: "Rules" })).toMatchObject({ ok: true });
    const after = await loadJudgingResults(ctx);
    expect(after?.rows.map((r) => [r.submissionId, r.score, r.rank])).toEqual([
      [s3, 80, 1],
      [s1, 76.7, 2],
      [s4, null, null],
      [s2, null, null],
    ]);
  });

  it("shows the Judging dashboard tab only on events that use judging", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    const dashboard = async () => ({ event: await prisma.event.findUniqueOrThrow({ where: { id: event.id } }) }) as unknown as EventDashboardContext;
    expect(await eventUsesJudging(await dashboard())).toBe(false);
    await openWindow(ctx);
    expect(await eventUsesJudging(await dashboard())).toBe(true);
    const { teamId } = await createTeam(event, `Tab ${suffix}`);
    await saveSubmissionDraft(await teamAuth(teamId), { title: "Kept" });
    // Turned off with a project left: the tab stays so organisers can still manage it.
    expect(await updateJudgingSettings(ctx, { submissionsEnabled: false, submissionsOpenAt: "", submissionsCloseAt: "", judgesSeeAll: true, projectGalleryPublic: false })).toMatchObject({ ok: true });
    expect(await eventUsesJudging(await dashboard())).toBe(true);
    await prisma.submission.deleteMany({ where: { teamId } });
    expect(await eventUsesJudging(await dashboard())).toBe(false);
  });
});
