import { EventPrivacyType, EventStatus, JudgingStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => vi.fn(async (): Promise<{ user: { id: string } } | null> => null));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { buildJudgingExportRows, createEventAward, disqualifySubmission, loadJudgeProgress, loadJudgingResults, loadProjectGallery, loadPublicResults, publishResults, reinstateSubmission, saveJudgeScores, saveSubmissionDraft, setAwardWinner, setJudgingStatus, submitJudgeReview, submitSubmission, unpublishResults, updateJudgingSettings, withdrawSubmission } from "@/lib/core/judging";
import { closeWindow, content, createEvent, createJudge, createTeam, createUser, criterion, joinTeam, judgingSession, openWindow, organiser, organiserId, otherOrganisationId, otherOrganiserId, otherOrgSlug, register, setUpJudgingSuite, submissionIdFor, suffix, tearDownJudgingSuite, teamAuth } from "./helpers/judging";

// docs/HACKATHON.md "Tests", counted reviews, results announcements, awards, and the public results page. Shared setup: tests/integration/helpers/judging.ts.
const { publicPage } = judgingSession(authMock);

describe.sequential("hackathon judging integration", () => {
  beforeAll(setUpJudgingSuite);

  afterAll(tearDownJudgingSuite);

  it("counts only reviews by current judges without a conflict of interest", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const { teamId } = await createTeam(event, `Counted ${suffix}`);
    expect(await submitSubmission(await teamAuth(teamId), { title: "Counted" })).toMatchObject({ ok: true });
    const submissionId = await submissionIdFor({ teamId });
    const c = await criterion(ctx, { name: "Impact", weight: 1, maxScore: 10 });
    const stays = await createJudge(event, "stays");
    const revoked = await createJudge(event, "revoked");
    const conflicted = await createJudge(event, "conflicted-later");
    await setJudgingStatus(ctx, JudgingStatus.OPEN);
    for (const [judge, score] of [[stays, 8], [revoked, 2], [conflicted, 10]] as const) {
      expect(await saveJudgeScores(judge.ctx, { submissionId, scores: [{ criterionId: c, score }] })).toMatchObject({ ok: true });
      expect(await submitJudgeReview(judge.ctx, { submissionId })).toMatchObject({ ok: true, data: { submitted: true } });
    }
    expect((await loadJudgingResults(ctx))?.rows[0]).toMatchObject({ score: 66.7, judgesCounted: 3 });

    // Submissions (the whole feature) can't be switched off once judging has started.
    expect(await updateJudgingSettings(ctx, { submissionsEnabled: false, submissionsOpenAt: "", submissionsCloseAt: "", judgesSeeAll: true, projectGalleryPublic: false })).toMatchObject({ ok: false, fieldErrors: { submissionsEnabled: [expect.any(String)] } });
    expect(await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ submissionsEnabled: true });

    // The JUDGE grant is revoked; another judge's account later joins the team.
    await prisma.eventCollaborator.deleteMany({ where: { eventId: event.id, userId: revoked.userId } });
    await joinTeam(event, teamId, { userId: conflicted.userId });
    const results = await loadJudgingResults(ctx);
    expect(results?.rows[0]).toMatchObject({ submissionId, score: 80, judgesCounted: 1 });
    const progress = await loadJudgeProgress(ctx);
    expect(progress?.find((j) => j.userId === revoked.userId)).toMatchObject({ visible: 0, reviewsSubmitted: 0 });
    expect(progress?.find((j) => j.userId === conflicted.userId)).toMatchObject({ visible: 0, reviewsSubmitted: 0 });
    expect(progress?.find((j) => j.userId === stays.userId)).toMatchObject({ visible: 1, reviewsSubmitted: 1 });
    // Their reviews stay on record, marked as not counted in the export.
    const csv = await buildJudgingExportRows(ctx);
    const counted = csv?.slice(1).map((line) => [line[8], line[10]]).sort();
    expect(counted).toEqual([
      [`conflicted-later ${suffix.slice(0, 6)}`, "No"],
      [`revoked ${suffix.slice(0, 6)}`, "No"],
      [`stays ${suffix.slice(0, 6)}`, "Yes"],
    ]);
  });

  it("emails each confirmed registration the results announcement once across re-publication", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const { teamId, leader } = await createTeam(event, `Announce ${suffix}`);
    const solo = await register(event, "announce-solo");
    expect(await submitSubmission(await teamAuth(teamId), { title: "Announced" })).toMatchObject({ ok: true });
    await criterion(ctx, { name: "Impact", weight: 1, maxScore: 10 });
    await setJudgingStatus(ctx, JudgingStatus.OPEN);
    await setJudgingStatus(ctx, JudgingStatus.CLOSED);
    const announcements = { kind: "results-published", payload: { path: ["eventId"], equals: event.id } };
    const emails = await prisma.rSVP.findMany({ where: { id: { in: [leader.rsvpId, solo.rsvpId] } }, select: { id: true, guestEmail: true } });
    const leaderEmail = emails.find((row) => row.id === leader.rsvpId)!.guestEmail!.toLowerCase();
    const soloEmail = emails.find((row) => row.id === solo.rsvpId)!.guestEmail!.toLowerCase();

    // Nothing delivered before the unpublish: the next publication announces again.
    expect(await publishResults(ctx)).toMatchObject({ ok: true, data: { queued: 2 } });
    expect(await unpublishResults(ctx)).toMatchObject({ ok: true });
    expect(await prisma.outboxMessage.count({ where: announcements })).toBe(0);
    expect(await publishResults(ctx)).toMatchObject({ ok: true, data: { queued: 2 } });

    // The leader's copy is delivered, the solo registrant's is still queued.
    const leaderMessage = (await prisma.outboxMessage.findMany({ where: announcements })).find((m) => (m.payload as { to: string }).to === leaderEmail)!;
    await prisma.outboxMessage.update({ where: { id: leaderMessage.id }, data: { status: "SENT", sentAt: new Date() } });
    expect(await unpublishResults(ctx)).toMatchObject({ ok: true });
    expect(await publishResults(ctx)).toMatchObject({ ok: true, data: { queued: 1 } });
    const rows = await prisma.outboxMessage.findMany({ where: announcements });
    const perAddress = (to: string) => rows.filter((m) => (m.payload as { to: string }).to === to).length;
    expect(perAddress(leaderEmail)).toBe(1);
    expect(perAddress(soloEmail)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Awards and results
  // -------------------------------------------------------------------------

  it("only lets submitted projects win awards", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const [draftTeam, withdrawnTeam, dqTeam, winnerTeam] = await Promise.all(["Draft", "Withdrawn", "DQ", "Winner"].map((name) => createTeam(event, `${name} ${suffix}`)));
    await saveSubmissionDraft(await teamAuth(draftTeam.teamId), { title: "Draft" });
    const withdrawnAuth = await teamAuth(withdrawnTeam.teamId);
    await submitSubmission(withdrawnAuth, { title: "Withdrawn" });
    await withdrawSubmission(withdrawnAuth);
    await submitSubmission(await teamAuth(dqTeam.teamId), { title: "DQ" });
    const winnerAuth = await teamAuth(winnerTeam.teamId);
    await submitSubmission(winnerAuth, { title: "Winner" });
    const [draft, withdrawn, dq, winner] = await Promise.all([draftTeam, withdrawnTeam, dqTeam, winnerTeam].map((team) => submissionIdFor({ teamId: team.teamId })));
    await disqualifySubmission(ctx, { submissionId: dq, reason: "Late" });

    const award = await createEventAward(ctx, { name: "Overall winner", description: "Best project" });
    if (!award.ok) throw new Error(award.error);
    const onlySubmitted = { ok: false, error: "Only submitted projects can win an award." };
    for (const submissionId of [draft, withdrawn, dq]) {
      expect(await setAwardWinner(ctx, { awardId: award.data.id, submissionId })).toMatchObject(onlySubmitted);
    }
    expect(await setAwardWinner(ctx, { awardId: award.data.id, submissionId: winner })).toMatchObject({ ok: true });
    expect(await setAwardWinner(ctx, { awardId: award.data.id, submissionId: dq, place: 2 })).toMatchObject(onlySubmitted);
    expect(await prisma.eventAwardWinner.findMany({ where: { awardId: award.data.id }, select: { submissionId: true, place: true } })).toEqual([{ submissionId: winner, place: 1 }]);

    // Disqualifying or withdrawing a winner removes the win.
    expect(await reinstateSubmission(ctx, dq)).toMatchObject({ ok: true });
    expect(await setAwardWinner(ctx, { awardId: award.data.id, submissionId: dq, place: 2 })).toMatchObject({ ok: true });
    expect(await disqualifySubmission(ctx, { submissionId: dq, reason: "Again" })).toMatchObject({ ok: true });
    expect(await withdrawSubmission(winnerAuth)).toMatchObject({ ok: true });
    expect(await prisma.eventAwardWinner.count({ where: { awardId: award.data.id } })).toBe(0);
    // The database also refuses a place below 1.
    await expect(prisma.eventAwardWinner.create({ data: { awardId: award.data.id, submissionId: draft, place: 0 } })).rejects.toThrow();
  });

  it("hides the results page until published and for non-public events", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const { teamId, leader } = await createTeam(event, `Champions ${suffix}`);
    const winnerAuth = await teamAuth(teamId);
    await submitSubmission(winnerAuth, { ...content, title: "Champion project" });
    const solo = await register(event, "solo");
    const winner = await submissionIdFor({ teamId });
    const c = await criterion(ctx, { name: "Impact", weight: 1, maxScore: 5 });
    const award = await createEventAward(ctx, { name: "Overall winner" });
    if (!award.ok) throw new Error(award.error);
    await setAwardWinner(ctx, { awardId: award.data.id, submissionId: winner });
    const judge = await createJudge(event);
    await setJudgingStatus(ctx, JudgingStatus.OPEN);
    await saveJudgeScores(judge.ctx, { submissionId: winner, scores: [{ criterionId: c, score: 5 }] });
    await submitJudgeReview(judge.ctx, { submissionId: winner, comment: "Secret judge comment" });

    // Unpublished: a 404 for everyone, on a fully public event.
    expect(await publicPage(null, event.id, loadPublicResults)).toBeNull();
    // Publishing needs judging closed.
    expect(await publishResults(ctx)).toMatchObject({ ok: false, error: "Close judging before publishing results." });
    expect(await publicPage(null, event.id, loadPublicResults)).toBeNull();
    await setJudgingStatus(ctx, JudgingStatus.CLOSED);
    const published = await publishResults(ctx);
    expect(published).toMatchObject({ ok: true, data: { alreadyPublished: false, queued: 2 } });
    const recipients = await prisma.outboxMessage.findMany({ where: { kind: "results-published", payload: { path: ["eventId"], equals: event.id } } });
    const emails = await prisma.rSVP.findMany({ where: { id: { in: [leader.rsvpId, solo.rsvpId] } }, select: { guestEmail: true } });
    expect(recipients.map((m) => (m.payload as { to: string }).to).sort()).toEqual(emails.map((r) => r.guestEmail!.toLowerCase()).sort());
    expect(await prisma.auditEvent.count({ where: { action: "JUDGING_RESULTS_PUBLISHED", targetId: event.id } })).toBe(1);

    const results = await publicPage(null, event.id, loadPublicResults);
    expect(results?.awards).toEqual([expect.objectContaining({ name: "Overall winner", winners: [expect.objectContaining({ place: 1, title: "Champion project", entrantName: `Champions ${suffix}`, isTeam: true })] })]);
    expect(JSON.stringify(results)).not.toMatch(/Secret judge comment|"score"|@example\.test|checkInToken|Impact/);
    // Judging cannot reopen under published results.
    expect(await setJudgingStatus(ctx, JudgingStatus.OPEN)).toMatchObject({ ok: false });

    // The same published results are a 404 when the event page itself is not public.
    await prisma.eventPage.update({ where: { eventId: event.id }, data: { isPublished: false } });
    expect(await publicPage(null, event.id, loadPublicResults)).toBeNull();
    await prisma.eventPage.update({ where: { eventId: event.id }, data: { isPublished: true } });
    for (const status of [EventStatus.DRAFT, EventStatus.HIDDEN, EventStatus.CANCELLED]) {
      await prisma.event.update({ where: { id: event.id }, data: { status } });
      expect(await publicPage(null, event.id, loadPublicResults), status).toBeNull();
      expect(await publicPage(judge.userId, event.id, loadPublicResults), status).toBeNull();
      // Exactly like the event page, organisers who can edit it get a preview.
      expect(await publicPage(organiserId, event.id, loadPublicResults), status).not.toBeNull();
    }
    await prisma.event.update({ where: { id: event.id }, data: { status: EventStatus.PUBLISHED, privacyType: EventPrivacyType.INVITE_ONLY } });
    const invited = await createUser("invited");
    const uninvited = await createUser("uninvited");
    await prisma.eventInvite.create({ data: { eventId: event.id, email: invited.email!.toLowerCase() } });
    expect(await publicPage(null, event.id, loadPublicResults)).toBeNull();
    expect(await publicPage(uninvited.id, event.id, loadPublicResults)).toBeNull();
    expect(await publicPage(invited.id, event.id, loadPublicResults)).not.toBeNull();
    // A judge's grant is not an invite either.
    expect(await publicPage(judge.userId, event.id, loadPublicResults)).toBeNull();
    // The gallery follows the same rules once the window has closed.
    await closeWindow(ctx);
    expect(await publicPage(null, event.id, loadProjectGallery)).toBeNull();
    expect((await publicPage(invited.id, event.id, loadProjectGallery))?.projects.map((p) => p.title)).toEqual(["Champion project"]);
    await prisma.event.update({ where: { id: event.id }, data: { privacyType: EventPrivacyType.PUBLIC } });
    expect((await publicPage(null, event.id, loadProjectGallery))?.projects).toHaveLength(1);
    await closeWindow(ctx, { projectGalleryPublic: false });
    expect(await publicPage(null, event.id, loadProjectGallery)).toBeNull();

    // Publishing again is idempotent; unpublishing hides the page and drops unsent announcements.
    expect(await publishResults(ctx)).toMatchObject({ ok: true, data: { alreadyPublished: true, queued: 0 } });
    expect(await unpublishResults(ctx)).toMatchObject({ ok: true });
    expect(await publicPage(null, event.id, loadPublicResults)).toBeNull();
    expect(await prisma.outboxMessage.count({ where: { kind: "results-published", status: "PENDING", payload: { path: ["eventId"], equals: event.id } } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { action: "JUDGING_RESULTS_UNPUBLISHED", targetId: event.id } })).toBe(1);

    // Another organisation's organiser cannot publish this event's results.
    const foreignCtx: JudgingOrganiserContext = { ...ctx, userId: otherOrganiserId, organisationId: otherOrganisationId, orgSlug: otherOrgSlug };
    expect(await publishResults(foreignCtx)).toMatchObject({ ok: false, error: "Event not found." });
    expect(await publicPage(null, event.id, loadPublicResults)).toBeNull();
  });
});
