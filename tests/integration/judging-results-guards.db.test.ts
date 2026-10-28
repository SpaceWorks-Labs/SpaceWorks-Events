import { JudgingStatus, OfflinePaymentMethod, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { countResultsAnnouncementRecipients, createEventAward, createJudgingCriterion, loadPublicResults, publishResults, setAwardWinner, setJudgingStatus } from "@/lib/core/judging";
import { applyAdvancement, createJudgingRound, finalizeJudgingRound, previewAdvancement, publishFinalists } from "@/lib/core/judgingRounds";
import { publicJudgingMetadata } from "@/lib/publicJudgingPage";
import { recordPrizePayout } from "@/lib/prizes";
import { createEvent, grantJudges, must, openRound, organiser, orgSlug, project, review, setUpRounds, suffix, tearDownRounds, twoRoundEvent, users } from "./helpers/judgingRounds";

/*
 * Publishing results (docs/HACKATHON.md "Rounds", "Awards"): award winners
 * must be finalists of a final round that takes advanced finalists (checked
 * when advancing, publishing, on the public page and for prize payouts), a
 * multi-round event publishes only from a finalised final round, and the
 * results email goes to entrants, never crew.
 */
describe.sequential("results publication guards", () => {
  beforeAll(setUpRounds);
  afterAll(tearDownRounds);

  it("keeps award winners to the final round's finalists and publishes only a finalised final round", async () => {
    const event = await createEvent();
    await grantJudges(event, users.j1);
    const ctx = await organiser(event);
    const projects = [await project(event, "First"), await project(event, "Second"), await project(event, "Third")];
    const impact = must(await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 10 }));
    must(await setJudgingStatus(ctx, JudgingStatus.OPEN));
    for (const [index, value] of [9, 7, 5].entries()) await review(event, users.j1, projects[index]!.id, impact.id, value);
    must(await setJudgingStatus(ctx, JudgingStatus.CLOSED));
    // Winners picked while the event had one round, the third project among them.
    const award = must(await createEventAward(ctx, { name: "Overall", description: "" }));
    must(await setAwardWinner(ctx, { awardId: award.id, submissionId: projects[0]!.id, place: 1 }));
    must(await setAwardWinner(ctx, { awardId: award.id, submissionId: projects[2]!.id, place: 2 }));

    // A final round with advanced finalists is added; the third project isn't advanced.
    const roundOne = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
    must(await finalizeJudgingRound(ctx, roundOne.id, { reason: "One judge is enough here." }));
    const finals = must(await createJudgingRound(ctx, { name: "Finals", entrySource: "ADVANCED", judgesSeeAll: true, freshEyes: false, reviewsPerProject: "", scoreNormalization: "RAW", opensAt: "", closesAt: "" }));
    const pitch = must(await createJudgingCriterion(ctx, { name: "Pitch", weight: 1, maxScore: 10 }, { roundId: finals.id }));
    const preview = must(await previewAdvancement(ctx, finals.id, { mode: "top", count: 2 }));
    expect(preview.awardWinnersRemoved).toBe(1);
    must(await applyAdvancement(ctx, finals.id, { mode: "top", count: 2, fingerprint: preview.fingerprint }));
    expect((await prisma.eventAwardWinner.findMany({ where: { awardId: award.id } })).map((row) => row.submissionId)).toEqual([projects[0]!.id]);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "JUDGING_FINALISTS_ADVANCED", targetId: event.id } });
    expect(audit.metadata).toMatchObject({ awardWinnersRemoved: 1 });

    // The final round is judged and closed, but not finalised: publishing waits for it.
    await openRound(ctx, finals.id);
    await review(event, users.j1, projects[0]!.id, pitch.id, 8);
    await review(event, users.j1, projects[1]!.id, pitch.id, 6);
    must(await setJudgingStatus(ctx, JudgingStatus.CLOSED));
    expect(await publishResults(ctx)).toMatchObject({ ok: false, error: expect.stringContaining("Finalise “Finals”") });
    must(await finalizeJudgingRound(ctx, finals.id, { reason: "One judge is enough here." }));

    // A winner outside the finalists (left from before) blocks publication.
    await prisma.eventAwardWinner.create({ data: { awardId: award.id, submissionId: projects[2]!.id, place: 3 } });
    expect(await setAwardWinner(ctx, { awardId: award.id, submissionId: projects[2]!.id, place: 2 })).toMatchObject({ ok: false, error: expect.stringContaining("final round") });
    expect(await publishResults(ctx)).toMatchObject({ ok: false, error: expect.stringContaining("isn't in the final round") });
    await prisma.eventAwardWinner.deleteMany({ where: { awardId: award.id, submissionId: projects[2]!.id } });
    must(await publishResults(ctx));

    // Should one appear anyway, the public page never shows it and no prize is paid to it.
    await prisma.eventAwardWinner.create({ data: { awardId: award.id, submissionId: projects[2]!.id, place: 3 } });
    const results = await loadPublicResults(event.id);
    expect(results?.awards[0]?.winners.map((winner) => winner.title)).toEqual(["First"]);
    const prizeCtx = { organisationId: ctx.organisationId, eventId: event.id, userId: users.owner };
    const payout = { awardId: award.id, recipientName: "Team", amount: "100", method: OfflinePaymentMethod.CASH };
    expect(await recordPrizePayout(prizeCtx, { ...payout, submissionId: projects[2]!.id })).toEqual({ ok: false, error: "That project hasn't won this award." });
    expect(await recordPrizePayout(prizeCtx, { ...payout, submissionId: projects[0]!.id })).toEqual({ ok: true });
  });

  it("titles the results page for its finalists until results are published", async () => {
    const { event, ctx, roundTwoId } = await twoRoundEvent([9, 7, 5]);
    const plan = must(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 2 }));
    must(await applyAdvancement(ctx, roundTwoId, { mode: "top", count: 2, fingerprint: plan.fingerprint }));
    expect(await publicJudgingMetadata(orgSlug, event.slug, "results")).toMatchObject({ title: "Results", robots: { index: false } });
    must(await publishFinalists(ctx, roundTwoId));
    expect(await publicJudgingMetadata(orgSlug, event.slug, "results")).toMatchObject({ title: `Finalists · ${event.title}`, description: `Finalists of ${event.title}.` });
  });

  it("publishes a single round without finalising, emailing entrants but never crew", async () => {
    const event = await createEvent();
    await prisma.event.update({ where: { id: event.id }, data: { emailEntrantsOnResults: true } });
    await grantJudges(event, users.j1);
    const ctx = await organiser(event);
    const entry = await project(event, "Solo");
    const crewEmail = `crew-${suffix}@example.test`;
    await prisma.rSVP.create({ data: { eventId: event.id, guestEmail: crewEmail, guestName: "Crew", attendeeKey: `guest:${crewEmail}`, status: RsvpStatus.CONFIRMED, isCrew: true } });
    const impact = must(await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 10 }));
    must(await setJudgingStatus(ctx, JudgingStatus.OPEN));
    await review(event, users.j1, entry.id, impact.id, 7);
    must(await setJudgingStatus(ctx, JudgingStatus.CLOSED));
    expect(await countResultsAnnouncementRecipients(ctx)).toBe(1);
    expect(must(await publishResults(ctx))).toMatchObject({ queued: 1, emailed: true });
    const queued = await prisma.outboxMessage.findMany({ where: { kind: "results-published", payload: { path: ["eventId"], equals: event.id } } });
    expect(queued.map((row) => (row.payload as { to: string }).to)).not.toContain(crewEmail);
  });
});
