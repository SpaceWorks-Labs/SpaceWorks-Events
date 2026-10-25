import { EventStatus, JudgingStatus, RegistrationMode, RsvpStatus, SubmissionStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => vi.fn(async (): Promise<{ user: { id: string } } | null> => null));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { resolveRsvpByTicketToken } from "@/lib/core/teams";
import { resolveJudgeContext, resolveJudgingOrganiser, type JudgeContext, type JudgingOrganiserContext } from "@/lib/judgingAccess";
import { assignJudge, buildJudgingExportRows, createEventAward, createJudgingCriterion, disqualifySubmission, listSubmissionsForJudge, listSubmissionsForOrganiser, loadEntrantSubmission, loadJudgeProgress, loadJudgingResults, loadJudgingResultsPage, publishResults, requestSubmissionLink, resolveEntrantBySubmissionLink, resolveEntrantForUser, saveJudgeScores, saveSubmissionDraft, searchAwardCandidates, setAwardWinner, setJudgingStatus, submitSubmission, updateJudgingSettings, withdrawSubmission } from "@/lib/core/judging";
import { HOUR, closeWindow, content, createEvent, createJudge, createTeam, createUser, criterion, currentSubmissionToken, joinTeam, openWindow, organiser, organiserId, orgSlug, otherOrganisationId, otherOrganiserId, otherOrgSlug, register, setUpJudgingSuite, setWindow, soloAuth, submissionIdFor, suffix, tearDownJudgingSuite, teamAuth } from "./helpers/judging";

// docs/HACKATHON.md "Tests", submissions: the window, confirmed entrants, scoping, and solo links. Shared setup: tests/integration/helpers/judging.ts.
describe.sequential("hackathon judging integration", () => {
  beforeAll(setUpJudgingSuite);

  afterAll(tearDownJudgingSuite);

  // -------------------------------------------------------------------------
  // Submissions
  // -------------------------------------------------------------------------

  it("refuses submissions outside the window, while disabled, and for unpublished events", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    const { teamId } = await createTeam(event, `Window ${suffix}`);
    const auth = await teamAuth(teamId);
    const closed = { ok: false, error: "Submissions are not open right now." };

    // Not enabled yet.
    expect(await saveSubmissionDraft(auth, content)).toMatchObject(closed);
    expect(await loadEntrantSubmission(auth)).toBeNull();

    // Opens in the future.
    await setWindow(ctx, new Date(Date.now() + HOUR), new Date(Date.now() + 2 * HOUR));
    expect(await submitSubmission(auth, content)).toMatchObject(closed);
    expect(await loadEntrantSubmission(auth)).toMatchObject({ window: { isOpen: false }, canEdit: false, submission: null });

    // Open: draft, edit, submit.
    await openWindow(ctx);
    expect(await saveSubmissionDraft(auth, content)).toMatchObject({ ok: true, data: { status: SubmissionStatus.DRAFT } });
    expect(await submitSubmission(auth, content)).toMatchObject({ ok: true, data: { status: SubmissionStatus.SUBMITTED } });
    // Saving a draft of a submitted project is an edit; it stays submitted.
    expect(await saveSubmissionDraft(auth, { ...content, title: "Edited" })).toMatchObject({ ok: true, data: { status: SubmissionStatus.SUBMITTED } });

    // Closed (in the past): no edits, no withdrawal, content unchanged.
    await closeWindow(ctx);
    expect(await submitSubmission(auth, { ...content, title: "Too late" })).toMatchObject(closed);
    expect(await saveSubmissionDraft(auth, { ...content, title: "Too late" })).toMatchObject(closed);
    expect(await withdrawSubmission(auth)).toMatchObject(closed);
    expect(await prisma.submission.findFirstOrThrow({ where: { teamId } })).toMatchObject({ title: "Edited", status: SubmissionStatus.SUBMITTED });
    expect(await loadEntrantSubmission(auth)).toMatchObject({ canEdit: false, submission: { title: "Edited" } });

    // Open window but the event is no longer published.
    await openWindow(ctx);
    const solo = await register(event, "solo");
    await prisma.event.update({ where: { id: event.id }, data: { status: EventStatus.CANCELLED } });
    expect(await submitSubmission(auth, content)).toMatchObject(closed);
    expect(await requestSubmissionLink({ rsvpId: solo.rsvpId, eventId: event.id })).toMatchObject({ ok: false, error: "This event is not taking project submissions." });
    // The entrant pages follow the event page's publication rule: a real 404.
    expect(await loadEntrantSubmission(auth)).toBeNull();
    await prisma.event.update({ where: { id: event.id }, data: { status: EventStatus.PUBLISHED } });
    await prisma.eventPage.update({ where: { eventId: event.id }, data: { isPublished: false } });
    expect(await loadEntrantSubmission(auth)).toBeNull();
    await prisma.eventPage.update({ where: { eventId: event.id }, data: { isPublished: true } });
    expect(await loadEntrantSubmission(auth)).toMatchObject({ canEdit: true, submission: { title: "Edited" } });

    // Turning submissions off closes the window too.
    expect(await updateJudgingSettings(ctx, { submissionsEnabled: false, submissionsOpenAt: "", submissionsCloseAt: "", judgesSeeAll: true, projectGalleryPublic: false })).toMatchObject({ ok: true });
    expect(await submitSubmission(auth, content)).toMatchObject(closed);
    expect(await prisma.auditEvent.count({ where: { action: "JUDGING_SETTINGS_UPDATED", targetId: event.id } })).toBeGreaterThanOrEqual(5);
  });

  it("refuses non-confirmed entrants", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const notConfirmed = { ok: false, error: "Only confirmed registrations can submit a project." };

    // A team that drafted while confirmed, then went to the waitlist.
    const { teamId } = await createTeam(event, `Moved ${suffix}`);
    const auth = await teamAuth(teamId);
    expect(await saveSubmissionDraft(auth, content)).toMatchObject({ ok: true });
    for (const status of [RsvpStatus.WAITLISTED, RsvpStatus.PENDING_APPROVAL, RsvpStatus.REJECTED]) {
      await prisma.$transaction([
        prisma.team.update({ where: { id: teamId }, data: { status } }),
        prisma.rSVP.updateMany({ where: { teamId }, data: { status } }),
      ]);
      // A declined (REJECTED) team is final, like the team-side refusals in lib/core/teams.ts.
      const declined = status === RsvpStatus.REJECTED;
      const refusal = declined ? { ok: false, error: "The organisers declined this registration, so its project can't be submitted or changed." } : notConfirmed;
      expect(await submitSubmission(auth, content)).toMatchObject(refusal);
      expect(await saveSubmissionDraft(auth, content)).toMatchObject(refusal);
      expect(await withdrawSubmission(auth)).toMatchObject(refusal);
      expect(await loadEntrantSubmission(auth)).toMatchObject({ confirmed: false, declined, canEdit: false });
    }
    expect((await prisma.submission.findFirstOrThrow({ where: { teamId } })).status).toBe(SubmissionStatus.DRAFT);

    // Solo registrants: no link and no submission unless confirmed.
    const solo = await register(event, "solo");
    const link = await soloAuth(solo.rsvpId, event.id);
    await prisma.rSVP.update({ where: { id: solo.rsvpId }, data: { status: RsvpStatus.WAITLISTED } });
    expect(await submitSubmission(link, content)).toMatchObject(notConfirmed);
    await prisma.submissionLink.update({ where: { rsvpId: solo.rsvpId }, data: { createdAt: new Date(Date.now() - HOUR) } });
    expect(await requestSubmissionLink({ rsvpId: solo.rsvpId, eventId: event.id })).toMatchObject(notConfirmed);

    // A cancelled solo registration takes its submission with it.
    await prisma.rSVP.update({ where: { id: solo.rsvpId }, data: { status: RsvpStatus.CONFIRMED } });
    expect(await submitSubmission(link, content)).toMatchObject({ ok: true });
    await prisma.rSVP.delete({ where: { id: solo.rsvpId } });
    expect(await prisma.submission.count({ where: { rsvpId: solo.rsvpId } })).toBe(0);
    expect(await resolveEntrantBySubmissionLink(await prisma.outboxMessage.findFirstOrThrow({
      where: { kind: "submission-link", payload: { path: ["rsvpId"], equals: solo.rsvpId } },
    }).then((message) => (message.payload as { token: string }).token))).toBeNull();
  });

  it("keeps entrants, organisers, and judges inside their own event and organisation", async () => {
    const event = await createEvent();
    const sibling = await createEvent();
    const foreign = await createEvent({ organisation: otherOrganisationId });
    const ctx = await organiser(event);
    const siblingCtx = await organiser(sibling);
    const foreignCtx = await organiser(foreign, otherOrganiserId);
    for (const c of [ctx, siblingCtx, foreignCtx]) await openWindow(c);

    const { teamId } = await createTeam(event, `Home ${suffix}`);
    const auth = await teamAuth(teamId);
    expect(await submitSubmission(auth, content)).toMatchObject({ ok: true });
    const own = await submissionIdFor({ teamId });

    // An entrant proof re-scoped to another event (same org or another org) finds nothing.
    for (const eventId of [sibling.id, foreign.id]) {
      expect(await submitSubmission({ ...auth, eventId }, content)).toMatchObject({ ok: false, error: "Submission not found." });
      expect(await withdrawSubmission({ ...auth, eventId })).toMatchObject({ ok: false });
      expect(await loadEntrantSubmission({ ...auth, eventId })).toBeNull();
    }
    expect(await prisma.submission.count({ where: { eventId: { in: [sibling.id, foreign.id] } } })).toBe(0);
    // A team member account is only an entrant on its own event.
    const memberUser = await createUser("member");
    await joinTeam(event, teamId, { userId: memberUser.id });
    expect(await resolveEntrantForUser(memberUser.id, event.id)).toMatchObject({ kind: "team-member", teamId });
    expect(await resolveEntrantForUser(memberUser.id, sibling.id)).toBeNull();

    // Organisers: the resolver re-reads the event in the slug's organisation.
    expect(await resolveJudgingOrganiser(organiserId, orgSlug, foreign.id)).toBeNull();
    expect(await resolveJudgingOrganiser(organiserId, otherOrgSlug, foreign.id)).toBeNull();
    expect(await resolveJudgeContext(organiserId, orgSlug, foreign.id)).toBeNull();
    // A forged context (own organisation, foreign event) changes and reads nothing.
    const forged: JudgingOrganiserContext = { ...ctx, eventId: foreign.id, eventSlug: foreign.slug };
    expect(await updateJudgingSettings(forged, { submissionsEnabled: false, submissionsOpenAt: "", submissionsCloseAt: "", judgesSeeAll: true, projectGalleryPublic: false })).toMatchObject({ ok: false, error: "Event not found." });
    expect(await createJudgingCriterion(forged, { name: "X", weight: 1, maxScore: 5 })).toMatchObject({ ok: false });
    expect(await setJudgingStatus(forged, JudgingStatus.OPEN)).toMatchObject({ ok: false });
    expect(await publishResults(forged)).toMatchObject({ ok: false });
    expect(await loadJudgingResults(forged)).toBeNull();
    expect(await buildJudgingExportRows(forged)).toBeNull();
    expect(await listSubmissionsForOrganiser(forged)).toEqual({ submissions: [], nextCursor: null });
    expect(await loadJudgeProgress(forged)).toBeNull();
    expect(await loadJudgingResultsPage(forged)).toBeNull();
    expect(await searchAwardCandidates(forged)).toBeNull();
    expect((await prisma.event.findUniqueOrThrow({ where: { id: foreign.id } })).submissionsEnabled).toBe(true);

    // Ids from another event of the same organisation are refused.
    const siblingAward = await createEventAward(siblingCtx, { name: "Sibling award" });
    if (!siblingAward.ok) throw new Error(siblingAward.error);
    expect(await setAwardWinner(ctx, { awardId: siblingAward.data.id, submissionId: own })).toMatchObject({ ok: false, error: "Award not found." });
    expect(await setAwardWinner(siblingCtx, { awardId: siblingAward.data.id, submissionId: own })).toMatchObject({ ok: false, error: "Submission not found." });
    expect(await disqualifySubmission(siblingCtx, { submissionId: own, reason: "Nope" })).toMatchObject({ ok: false });
    const judge = await createJudge(event);
    expect(await assignJudge(siblingCtx, { judgeUserId: judge.userId, submissionId: own })).toMatchObject({ ok: false });
    expect((await prisma.submission.findUniqueOrThrow({ where: { id: own } })).status).toBe(SubmissionStatus.SUBMITTED);

    // A judge's context forged onto another event, and another event's criterion.
    const forgedJudge: JudgeContext = { ...judge.ctx, eventId: foreign.id };
    expect(await listSubmissionsForJudge(forgedJudge)).toBeNull();
    expect(await listSubmissionsForJudge({ ...judge.ctx, eventId: sibling.id })).toBeNull();
    const homeCriterion = await criterion(ctx, { name: "Impact", weight: 1, maxScore: 5 });
    const siblingCriterion = await criterion(siblingCtx, { name: "Sibling", weight: 1, maxScore: 5 });
    expect(await setJudgingStatus(ctx, JudgingStatus.OPEN)).toMatchObject({ ok: true });
    expect(await saveJudgeScores(judge.ctx, { submissionId: own, scores: [{ criterionId: siblingCriterion, score: 3 }] })).toMatchObject({ ok: false, error: "Unknown criterion." });
    expect(await saveJudgeScores(judge.ctx, { submissionId: own, scores: [{ criterionId: homeCriterion, score: 3 }] })).toMatchObject({ ok: true });
  });

  it("never lets a solo submission token edit another entrant", async () => {
    const event = await createEvent({ registrationMode: RegistrationMode.INDIVIDUAL });
    const other = await createEvent({ registrationMode: RegistrationMode.INDIVIDUAL });
    await openWindow(await organiser(event));
    await openWindow(await organiser(other));
    const alice = await register(event, "alice");
    const bob = await register(event, "bob");
    const carol = await register(other, "carol");

    // Holding a ticket only lets the holder ask for an email to the registration's own address.
    const holder = await resolveRsvpByTicketToken(alice.ticketToken, null);
    if (!holder) throw new Error("ticket did not resolve");
    expect(await requestSubmissionLink(holder)).toEqual({ ok: true, data: { sent: true } });
    const message = await prisma.outboxMessage.findFirstOrThrow({ where: { kind: "submission-link", payload: { path: ["rsvpId"], equals: alice.rsvpId } } });
    const aliceRsvp = await prisma.rSVP.findUniqueOrThrow({ where: { id: alice.rsvpId } });
    expect((message.payload as { to: string }).to).toBe(aliceRsvp.guestEmail);
    // Only the digest is stored.
    const stored = await prisma.submissionLink.findUniqueOrThrow({ where: { rsvpId: alice.rsvpId } });
    expect(stored.tokenHash).not.toBe((message.payload as { token: string }).token);

    const aliceAuth = await resolveEntrantBySubmissionLink(await currentSubmissionToken(alice.rsvpId));
    if (!aliceAuth || aliceAuth.kind !== "solo-link") throw new Error("link did not resolve");
    expect(await submitSubmission(aliceAuth, { title: "Alice" })).toMatchObject({ ok: true });

    // Alice's link with Bob's (or Carol's) registration id: nothing.
    for (const forged of [{ ...aliceAuth, rsvpId: bob.rsvpId }, { ...aliceAuth, rsvpId: carol.rsvpId, eventId: other.id }]) {
      expect(await submitSubmission(forged, { title: "Hijack" })).toMatchObject({ ok: false, error: "Submission not found." });
      expect(await saveSubmissionDraft(forged, { title: "Hijack" })).toMatchObject({ ok: false });
      expect(await withdrawSubmission(forged)).toMatchObject({ ok: false });
      expect(await loadEntrantSubmission(forged)).toBeNull();
    }
    expect(await prisma.submission.count({ where: { rsvpId: { in: [bob.rsvpId, carol.rsvpId] } } })).toBe(0);
    // A solo-owner proof for an account that does not own the RSVP.
    const stranger = await createUser("stranger");
    expect(await submitSubmission({ kind: "solo-owner", eventId: event.id, rsvpId: bob.rsvpId, userId: stranger.id }, { title: "Hijack" })).toMatchObject({ ok: false });
    expect(await resolveEntrantForUser(stranger.id, event.id)).toBeNull();
    // Malformed and unknown tokens.
    expect(await resolveEntrantBySubmissionLink("x".repeat(43))).toBeNull();
    expect(await resolveEntrantBySubmissionLink("short")).toBeNull();

    // Within the cooldown no new link is sent; after it, regenerating retires the old link.
    const firstToken = await currentSubmissionToken(alice.rsvpId);
    expect(await requestSubmissionLink(holder)).toEqual({ ok: true, data: { sent: false } });
    await prisma.submissionLink.update({ where: { rsvpId: alice.rsvpId }, data: { createdAt: new Date(Date.now() - HOUR) } });
    expect(await requestSubmissionLink(holder)).toEqual({ ok: true, data: { sent: true } });
    const secondToken = await currentSubmissionToken(alice.rsvpId);
    expect(secondToken).not.toBe(firstToken);
    expect(await resolveEntrantBySubmissionLink(firstToken)).toBeNull();
    expect(await submitSubmission(aliceAuth, { title: "Old link" })).toMatchObject({ ok: false });
    expect(await resolveEntrantBySubmissionLink(secondToken)).toMatchObject({ kind: "solo-link", rsvpId: alice.rsvpId });

    // Team members never get a solo link: their team page or account edits the team project.
    const teamEvent = await createEvent();
    await openWindow(await organiser(teamEvent));
    const { leader } = await createTeam(teamEvent, `Linkless ${suffix}`);
    expect(await requestSubmissionLink({ rsvpId: leader.rsvpId, eventId: teamEvent.id })).toMatchObject({ ok: false });
    // A ticket's registration id paired with another event is refused.
    expect(await requestSubmissionLink({ rsvpId: bob.rsvpId, eventId: other.id })).toMatchObject({ ok: false, error: "Submission not found." });
  });
});
