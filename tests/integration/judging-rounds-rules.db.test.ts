import { SubmissionStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { createEventAward, listSubmissionsForJudge, setAwardWinner, setScoreNormalization } from "@/lib/core/judging";
import { setReviewsPerProject } from "@/lib/core/judgingOps";
import { applyAdvancement, previewAdvancement, publishFinalists, updateJudgingRound } from "@/lib/core/judgingRounds";
import { restoreSubmissionSnapshotTx, type SubmissionSnapshot } from "@/lib/core/submissionLifecycle";
import { judge, must, openRound, project, setUpRounds, tearDownRounds, twoRoundEvent, users } from "./helpers/judgingRounds";

/*
 * Judging round rules (docs/HACKATHON.md "Rounds"): finalised rounds keep
 * their target and score method, judges never open a later DRAFT round,
 * only final-round finalists win awards, one finalist email per person, and
 * older undo snapshots restore into the first round.
 */

const settings = (extra: Record<string, unknown> = {}) => ({ name: "Main", entrySource: "ALL_SUBMITTED", judgesSeeAll: true, freshEyes: false, reviewsPerProject: "2", scoreNormalization: "RAW", opensAt: "", closesAt: "", ...extra });

describe.sequential("judging round rules", () => {
  beforeAll(setUpRounds);
  afterAll(tearDownRounds);

  it("keeps a finalised round's target and score method", async () => {
    const { ctx, roundOneId } = await twoRoundEvent([9, 7]);
    expect(await updateJudgingRound(ctx, roundOneId, settings({ scoreNormalization: "ZSCORE" }))).toMatchObject({ ok: false, error: expect.stringContaining("finalised") });
    expect(await updateJudgingRound(ctx, roundOneId, settings({ reviewsPerProject: "3" }))).toMatchObject({ ok: false });
    expect(await setScoreNormalization(ctx, "ZSCORE")).toMatchObject({ ok: false, error: expect.stringContaining("finalised") });
    expect(await setReviewsPerProject(ctx, 3)).toMatchObject({ ok: false, error: expect.stringContaining("finalised") });
    // The name and planned times still change.
    must(await updateJudgingRound(ctx, roundOneId, settings({ name: "Qualifiers" })));
  });

  it("never lets a judge open a later DRAFT round", async () => {
    const { event, roundOneId, roundTwoId } = await twoRoundEvent([9, 7]);
    const ctx = await judge(event, users.j1);
    expect(await listSubmissionsForJudge(ctx, {}, { roundId: roundTwoId })).toBeNull();
    const workspace = await listSubmissionsForJudge(ctx);
    expect(workspace?.round?.id).toBe(roundOneId);
    expect(workspace?.rounds.map((round) => round.id)).toEqual([roundOneId]);
  });

  it("awards only the final round's finalists once rounds advance", async () => {
    const { ctx, projects, roundTwoId } = await twoRoundEvent([9, 7, 5]);
    const preview = must(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 2 }));
    must(await applyAdvancement(ctx, roundTwoId, { mode: "top", count: 2, fingerprint: preview.fingerprint }));
    const award = must(await createEventAward(ctx, { name: "Best", description: "" }));
    expect(await setAwardWinner(ctx, { awardId: award.id, submissionId: projects[2]!.id, place: 1 })).toMatchObject({ ok: false, error: "Only projects in the final round can win an award." });
    must(await setAwardWinner(ctx, { awardId: award.id, submissionId: projects[0]!.id, place: 1 }));
  });

  it("sends one finalist email per person, listing all their finalist projects", async () => {
    const { event, ctx, roundTwoId } = await twoRoundEvent([9, 7]);
    // One address behind two finalist projects: the entrant's account, and a guest registration with the same address.
    const entrant = await prisma.user.findUniqueOrThrow({ where: { id: users.entrant } });
    const viaAccount = await project(event, "Twin A", users.entrant);
    const guest = await prisma.rSVP.create({ data: { eventId: event.id, guestEmail: entrant.email!.toUpperCase(), guestName: "Twin", attendeeKey: `guest:twin-${event.id}`, status: "CONFIRMED" } });
    const viaGuest = await prisma.submission.create({ data: { eventId: event.id, rsvpId: guest.id, title: "Twin B", status: SubmissionStatus.SUBMITTED, submittedAt: new Date() } });
    const both = [viaAccount, viaGuest];
    await prisma.judgingRoundEntry.createMany({ data: both.map((item) => ({ roundId: roundTwoId, submissionId: item.id })) });
    await prisma.event.update({ where: { id: event.id }, data: { emailEntrantsOnResults: true } });
    must(await publishFinalists(ctx, roundTwoId));
    const rows = await prisma.outboxMessage.findMany({ where: { kind: "finalists-announced", payload: { path: ["roundId"], equals: roundTwoId } } });
    const mine = rows.filter((row) => (row.payload as { to: string }).to === entrant.email!.toLowerCase());
    expect(mine).toHaveLength(1);
    expect((mine[0]!.payload as { submissionIds: string[] }).submissionIds.sort()).toEqual(both.map((item) => item.id).sort());
  });

  it("restores an undo snapshot from before rounds into the first round, scores and reviews together", async () => {
    const { event, ctx, projects, roundTwoId, firstCriterionId } = await twoRoundEvent([9, 7]);
    const preview = must(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 1 }));
    must(await applyAdvancement(ctx, roundTwoId, { mode: "top", count: 1, fingerprint: preview.fingerprint }));
    await openRound(ctx, roundTwoId);
    // A legacy snapshot (no roundId on its rows) of the second project, deleted meanwhile.
    const original = projects[1]!;
    await prisma.submission.delete({ where: { id: original.id } });
    const snapshot: SubmissionSnapshot = {
      id: original.id, eventId: event.id, title: original.title, summary: "", repoUrl: null, demoUrl: null, videoUrl: null,
      status: SubmissionStatus.SUBMITTED, submittedAt: new Date().toISOString(), disqualifiedReason: null, createdAt: new Date().toISOString(),
      scores: [{ judgeUserId: users.j1, criterionId: firstCriterionId, score: 7, createdAt: new Date().toISOString() }],
      reviews: [{ judgeUserId: users.j1, comment: "", submittedAt: new Date().toISOString(), createdAt: new Date().toISOString() }],
      assignments: [{ judgeUserId: users.j1, createdAt: new Date().toISOString() }],
      awardWins: [],
    };
    await prisma.$transaction((tx) => restoreSubmissionSnapshotTx(tx, snapshot, { eventId: event.id, rsvpId: original.rsvpId! }));
    const first = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).currentJudgingRoundId).toBe(roundTwoId);
    expect(await prisma.judgeReview.findMany({ where: { submissionId: original.id }, select: { roundId: true } })).toEqual([{ roundId: first.id }]);
    expect(await prisma.judgeAssignment.findMany({ where: { submissionId: original.id }, select: { roundId: true } })).toEqual([{ roundId: first.id }]);
    expect(await prisma.judgeScore.count({ where: { submissionId: original.id, criterion: { roundId: first.id } } })).toBe(1);
  });
});
