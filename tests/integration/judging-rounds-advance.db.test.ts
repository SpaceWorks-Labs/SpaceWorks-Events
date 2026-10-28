import { JudgingStatus, OutboxStatus, SubmissionStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { createEventAward, disqualifySubmission, listSubmissionsForJudge, loadJudgingResults, publishResults, searchAwardCandidates, setAwardWinner, setJudgingStatus } from "@/lib/core/judging";
import { applyAdvancement, finalizeJudgingRound, loadPublicFinalists, previewAdvancement, publishFinalists, setJudgingRoundStatus, unpublishFinalists } from "@/lib/core/judgingRounds";
import { judge, must, openRound, project, review, setUpRounds, tearDownRounds, twoRoundEvent, users } from "./helpers/judgingRounds";

/*
 * Finalist advancement and the final round (docs/HACKATHON.md "Rounds"):
 * preview writes nothing, apply under the lock with a fingerprint, only from
 * a finalised round, frozen once the next round opens, disqualified projects
 * never advance, ADVANCED rounds show only their finalists, results and
 * awards come from the final round, and finalist publication and email.
 */

describe.sequential("finalist advancement", () => {
  beforeAll(setUpRounds);
  afterAll(tearDownRounds);

  it("previews without writing, then applies the same plan; a changed plan is refused", async () => {
    const { ctx, projects, roundTwoId } = await twoRoundEvent([9, 7, 5, 3]);
    const preview = must(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 2 }));
    expect(preview.finalists.map((row) => row.title)).toEqual(["Project 1", "Project 2"]);
    expect(preview.candidates).toHaveLength(4);
    expect(await prisma.judgingRoundEntry.count({ where: { roundId: roundTwoId } })).toBe(0);
    expect(await applyAdvancement(ctx, roundTwoId, { mode: "top", count: 2, fingerprint: "stale" })).toMatchObject({ ok: false, error: expect.stringContaining("changed since the preview") });
    expect(must(await applyAdvancement(ctx, roundTwoId, { mode: "top", count: 2, fingerprint: preview.fingerprint }))).toEqual({ added: 2, removed: 0, finalists: 2 });
    const entries = await prisma.judgingRoundEntry.findMany({ where: { roundId: roundTwoId }, orderBy: { sourceRank: "asc" } });
    expect(entries.map((row) => [row.submissionId, row.sourceRank, row.advancedByUserId])).toEqual([
      [projects[0]!.id, 1, users.owner],
      [projects[1]!.id, 2, users.owner],
    ]);
    // Hand-picking replaces the list (one kept, one swapped).
    const picked = must(await previewAdvancement(ctx, roundTwoId, { mode: "pick", submissionIds: [projects[0]!.id, projects[3]!.id] }));
    expect(picked).toMatchObject({ added: 1, removed: 1, kept: 1 });
    must(await applyAdvancement(ctx, roundTwoId, { mode: "pick", submissionIds: [projects[0]!.id, projects[3]!.id], fingerprint: picked.fingerprint }));
    expect((await prisma.judgingRoundEntry.findMany({ where: { roundId: roundTwoId } })).map((row) => row.submissionId).sort()).toEqual([projects[0]!.id, projects[3]!.id].sort());
  });

  it("advances only from a finalised round and never a disqualified or withdrawn project", async () => {
    const { ctx, projects, roundOneId, roundTwoId } = await twoRoundEvent([9, 8, 7]);
    must(await disqualifySubmission(ctx, { submissionId: projects[0]!.id, reason: "Rules" }));
    await prisma.submission.update({ where: { id: projects[1]!.id }, data: { status: SubmissionStatus.WITHDRAWN } });
    const preview = must(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 3 }));
    expect(preview.finalists.map((row) => row.submissionId)).toEqual([projects[2]!.id]);
    expect(await previewAdvancement(ctx, roundTwoId, { mode: "pick", submissionIds: [projects[0]!.id] })).toMatchObject({ ok: false });
    // Undo finalising the first round: advancing is refused until it is finalised again.
    await prisma.judgingRound.update({ where: { id: roundOneId }, data: { finalizedAt: null } });
    expect(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 1 })).toMatchObject({ ok: false, error: expect.stringContaining("Finalise") });
  });

  it("freezes finalists once the round opens and shows judges only the finalists", async () => {
    const { event, ctx, projects, roundTwoId, secondCriterionId } = await twoRoundEvent([9, 7, 5]);
    const preview = must(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 2 }));
    must(await applyAdvancement(ctx, roundTwoId, { mode: "top", count: 2, fingerprint: preview.fingerprint }));
    await openRound(ctx, roundTwoId);
    expect(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 3 })).toMatchObject({ ok: false, error: "Finalists are fixed once the round opens." });
    const workspace = await listSubmissionsForJudge(await judge(event, users.j3));
    expect(workspace?.submissions.map((row) => row.id).sort()).toEqual([projects[0]!.id, projects[1]!.id].sort());
    expect(workspace?.round).toMatchObject({ id: roundTwoId, isCurrent: true });
    // The same judge reviews the same project again in the new round, separately.
    await review(event, users.j1, projects[0]!.id, secondCriterionId, 4);
    expect(await prisma.judgeReview.count({ where: { submissionId: projects[0]!.id, judgeUserId: users.j1 } })).toBe(2);
  });

  it("ranks, picks award candidates and publishes results from the final round", async () => {
    const { event, ctx, projects, roundTwoId, secondCriterionId } = await twoRoundEvent([9, 7, 5]);
    const preview = must(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 2 }));
    must(await applyAdvancement(ctx, roundTwoId, { mode: "top", count: 2, fingerprint: preview.fingerprint }));
    // Results can't be published while a later round is still to judge.
    expect(await publishResults(ctx)).toMatchObject({ ok: false, error: expect.stringContaining("later judging round") });
    await openRound(ctx, roundTwoId);
    // In the final round the second project wins.
    await review(event, users.j1, projects[0]!.id, secondCriterionId, 2);
    await review(event, users.j1, projects[1]!.id, secondCriterionId, 10);
    must(await setJudgingStatus(ctx, JudgingStatus.CLOSED));
    const results = await loadJudgingResults(ctx);
    expect(results?.roundId).toBe(roundTwoId);
    expect(results?.rows.map((row) => [row.submissionId, row.rank])).toEqual([
      [projects[1]!.id, 1],
      [projects[0]!.id, 2],
    ]);
    const candidates = await searchAwardCandidates(ctx);
    expect(candidates?.rows.map((row) => row.submissionId)).toEqual([projects[1]!.id, projects[0]!.id]);
    const award = must(await createEventAward(ctx, { name: "Overall winner", description: "" }));
    must(await setAwardWinner(ctx, { awardId: award.id, submissionId: projects[1]!.id, place: 1 }));
    // With more than one round, the final round is finalised before publishing.
    expect(await publishResults(ctx)).toMatchObject({ ok: false, error: expect.stringContaining("Finalise") });
    must(await finalizeJudgingRound(ctx, roundTwoId, { reason: "One judge for the finals." }));
    must(await publishResults(ctx));
    // The first round's own ranking is still there for the record.
    const first = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
    expect((await loadJudgingResults(ctx, { roundId: first.id }))?.rows[0]?.submissionId).toBe(projects[0]!.id);
  });

  it("publishes finalists separately from results, emailing entrants once only when results emails are on", async () => {
    const { event, ctx, projects, roundTwoId } = await twoRoundEvent([9, 7, 5]);
    expect(await publishFinalists(ctx, roundTwoId)).toMatchObject({ ok: false });
    const preview = must(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 2 }));
    must(await applyAdvancement(ctx, roundTwoId, { mode: "top", count: 2, fingerprint: preview.fingerprint }));
    expect(await loadPublicFinalists(event.id)).toEqual([]);
    // Off by default: the finalists go public, nobody is emailed or recorded as told.
    expect(must(await publishFinalists(ctx, roundTwoId))).toMatchObject({ queued: 0, emailed: false });
    expect(await prisma.judgingFinalistNotice.count({ where: { roundId: roundTwoId } })).toBe(0);
    const [block] = await loadPublicFinalists(event.id);
    expect(block?.roundName).toBe("Finals");
    expect(block?.finalists.map((row) => row.title).sort()).toEqual(["Project 1", "Project 2"]);
    expect(JSON.stringify(block)).not.toMatch(/score|rank|email|submissionId/i);
    must(await unpublishFinalists(ctx, roundTwoId));
    await prisma.event.update({ where: { id: event.id }, data: { emailEntrantsOnResults: true } });
    expect(must(await publishFinalists(ctx, roundTwoId))).toMatchObject({ queued: 2, emailed: true });
    const announced = await prisma.outboxMessage.findMany({ where: { kind: "finalists-announced", payload: { path: ["roundId"], equals: roundTwoId } } });
    expect(announced.flatMap((row) => (row.payload as { submissionIds: string[] }).submissionIds).sort()).toEqual([projects[0]!.id, projects[1]!.id].sort());
    expect(await prisma.judgingFinalistNotice.count({ where: { roundId: roundTwoId } })).toBe(2);
    // Changing finalists needs an unpublish; nobody is emailed twice, even once the outbox rows are gone.
    expect(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 1 })).toMatchObject({ ok: false });
    expect(must(await publishFinalists(ctx, roundTwoId)).queued).toBe(0);
    await prisma.outboxMessage.updateMany({ where: { id: announced[0]!.id }, data: { status: OutboxStatus.SENT, sentAt: new Date() } });
    must(await unpublishFinalists(ctx, roundTwoId));
    expect(await prisma.judgingFinalistNotice.count({ where: { roundId: roundTwoId } })).toBe(1);
    await prisma.outboxMessage.deleteMany({ where: { id: announced[0]!.id } });
    expect(must(await publishFinalists(ctx, roundTwoId)).queued).toBe(1);
    expect(await setJudgingRoundStatus(ctx, roundTwoId, "OPEN")).toMatchObject({ ok: true });
  });

  it("finalises a round with full coverage, or with a reason when projects are short", async () => {
    const { event, ctx } = await twoRoundEvent([9, 7]);
    const late = await project(event, "Late entry");
    const first = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
    await prisma.judgingRound.update({ where: { id: first.id }, data: { finalizedAt: null } });
    // Target 2 judges: the two judged projects have them, the late entry none (missing reviews never count as zero).
    expect(await finalizeJudgingRound(ctx, first.id, {})).toMatchObject({ ok: false, fieldErrors: { reason: [expect.stringContaining("1 project has fewer than 2")] } });
    expect(must(await finalizeJudgingRound(ctx, first.id, { reason: "Two judges were enough." }))).toEqual({ projects: 3, target: 2, short: 1 });
    expect(await prisma.judgingRound.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ finalizeExceptionReason: "Two judges were enough." });
    expect(await prisma.judgeScore.count({ where: { submissionId: late.id } })).toBe(0);
    expect(await setJudgingRoundStatus(ctx, first.id, "OPEN")).toMatchObject({ ok: false, error: expect.stringContaining("finalised") });
  });
});
