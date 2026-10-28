import { EventPermission } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { loadJudgingResults } from "@/lib/core/judging";
import { applyAdvancement, finalizeJudgingRound, previewAdvancement, unfinalizeJudgingRound } from "@/lib/core/judgingRounds";
import { captureSubmissionSnapshotTx, restoreSubmissionSnapshotTx, type SubmissionSnapshot } from "@/lib/core/submissionLifecycle";
import { must, openRound, setUpRounds, tearDownRounds, twoRoundEvent, users } from "./helpers/judgingRounds";

/*
 * A finalised round stays as finalised (docs/HACKATHON.md "Finalising"):
 * its counted reviews are frozen at finalise and read back by results and
 * advancement, whatever happens to judge grants later. And a deletion undo
 * puts a finalist place back into an opened round only when the deletion
 * took it from that opened round.
 */

async function deleteWithSnapshot(submissionId: string): Promise<{ snapshot: SubmissionSnapshot; rsvpId: string; eventId: string }> {
  const row = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId }, select: { rsvpId: true, eventId: true } });
  const snapshot = await prisma.$transaction(async (tx) => {
    const captured = await captureSubmissionSnapshotTx(tx, { eventId: row.eventId, rsvpId: row.rsvpId! });
    await tx.submission.delete({ where: { id: submissionId } });
    return captured!;
  });
  return { snapshot, rsvpId: row.rsvpId!, eventId: row.eventId };
}

async function restore(deleted: { snapshot: SubmissionSnapshot; rsvpId: string; eventId: string }) {
  await prisma.$transaction((tx) => restoreSubmissionSnapshotTx(tx, deleted.snapshot, { eventId: deleted.eventId, rsvpId: deleted.rsvpId }));
}

describe.sequential("frozen finalised rounds", () => {
  beforeAll(setUpRounds);
  afterAll(tearDownRounds);

  it("keeps a finalised round's counted reviews when a judge's grant goes, until it is unfinalised", async () => {
    const { event, ctx, projects, roundOneId, roundTwoId } = await twoRoundEvent([9, 7, 5]);
    expect(await prisma.judgingRoundCountedReview.count({ where: { roundId: roundOneId } })).toBe(6);
    expect(await prisma.judgingRound.findUniqueOrThrow({ where: { id: roundOneId } })).toMatchObject({ countedFrozenAt: expect.any(Date) });
    const before = await loadJudgingResults(ctx, { roundId: roundOneId });

    // j2 loses the JUDGE grant: the finalised ranking and coverage don't move.
    await prisma.eventCollaborator.deleteMany({ where: { eventId: event.id, userId: users.j2, permissions: { has: EventPermission.JUDGE } } });
    const after = await loadJudgingResults(ctx, { roundId: roundOneId });
    expect(after?.rows.map((row) => [row.submissionId, row.rank, row.judgesCounted])).toEqual(before?.rows.map((row) => [row.submissionId, row.rank, row.judgesCounted]));
    expect(after?.rows.every((row) => row.judgesCounted === 2)).toBe(true);
    expect(after?.countedReviewKeys).toHaveLength(6);
    // Advancement reads the frozen ranking too.
    const preview = must(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 2 }));
    expect(preview.finalists.map((row) => row.submissionId)).toEqual([projects[0]!.id, projects[1]!.id]);

    // Unfinalised, the round counts live again; finalising again freezes the new count.
    must(await unfinalizeJudgingRound(ctx, roundOneId));
    expect(await prisma.judgingRoundCountedReview.count({ where: { roundId: roundOneId } })).toBe(0);
    expect((await loadJudgingResults(ctx, { roundId: roundOneId }))?.rows.every((row) => row.judgesCounted === 1)).toBe(true);
    must(await finalizeJudgingRound(ctx, roundOneId, { reason: "A judge left." }));
    expect(await prisma.judgingRoundCountedReview.count({ where: { roundId: roundOneId } })).toBe(3);
  });

  it("restores a finalist place into a round that opened since only when the deletion took it from that open round", async () => {
    // Deleted while the finals were DRAFT; the finals open before the undo: no place back.
    const draft = await twoRoundEvent([9, 7, 5]);
    const plan = must(await previewAdvancement(draft.ctx, draft.roundTwoId, { mode: "top", count: 2 }));
    must(await applyAdvancement(draft.ctx, draft.roundTwoId, { mode: "top", count: 2, fingerprint: plan.fingerprint }));
    const early = await deleteWithSnapshot(draft.projects[0]!.id);
    expect(early.snapshot.roundEntries).toEqual([expect.objectContaining({ roundId: draft.roundTwoId, roundOpened: false })]);
    await openRound(draft.ctx, draft.roundTwoId);
    await restore(early);
    expect(await prisma.judgingRoundEntry.count({ where: { roundId: draft.roundTwoId, submissionId: draft.projects[0]!.id } })).toBe(0);
    // Its finalised first-round reviews still count after the undo.
    expect((await loadJudgingResults(draft.ctx, { roundId: draft.roundOneId }))?.rows.find((row) => row.submissionId === draft.projects[0]!.id)?.judgesCounted).toBe(2);

    // Deleted from the open finals: the undo puts it back.
    const open = await twoRoundEvent([9, 7, 5]);
    const openPlan = must(await previewAdvancement(open.ctx, open.roundTwoId, { mode: "top", count: 2 }));
    must(await applyAdvancement(open.ctx, open.roundTwoId, { mode: "top", count: 2, fingerprint: openPlan.fingerprint }));
    await openRound(open.ctx, open.roundTwoId);
    const late = await deleteWithSnapshot(open.projects[0]!.id);
    await restore(late);
    expect(await prisma.judgingRoundEntry.count({ where: { roundId: open.roundTwoId, submissionId: open.projects[0]!.id } })).toBe(1);

    // An older snapshot that didn't record it is not put back into an open round.
    const legacy = await deleteWithSnapshot(open.projects[1]!.id);
    const withoutFlag = legacy.snapshot.roundEntries?.map((entry) => ({ roundId: entry.roundId, advancedByUserId: entry.advancedByUserId, advancedAt: entry.advancedAt, sourceRank: entry.sourceRank }));
    await restore({ ...legacy, snapshot: { ...legacy.snapshot, roundEntries: withoutFlag } });
    expect(await prisma.judgingRoundEntry.count({ where: { roundId: open.roundTwoId, submissionId: open.projects[1]!.id } })).toBe(0);
  });
});
