import { EventPermission, JudgingStatus, RegistrationMode } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => vi.fn(async (): Promise<{ user: { id: string } } | null> => null));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { canAccessEvent, canManageRegistrationsFor } from "@/lib/eventAccess";
import { canManageWebhooks, getMembership } from "@/lib/permissions";
import { eventCapabilities } from "@/lib/eventDashboard/capabilities";
import { approveRsvp, reacceptRsvp } from "@/app/actions/rsvp-lifecycle";
import { checkInToListForUser, createCheckInListForUser, lookupListAttendeesForUser } from "@/lib/core/checkinLists";
import { loadEventBroadcastDraft, saveEventBroadcastDraft } from "@/app/actions/broadcasts";
import { GET as exportAttendees } from "@/app/api/exports/events/[eventId]/attendees/route";
import { judgingPermissionsFor } from "@/lib/judgingPermissions";
import { resolveOrganiserEvent } from "@/lib/core/teams";
import { deleteRsvp } from "@/app/actions/rsvp-admin";
import { resolveJudgeContext, resolveJudgingOrganiser } from "@/lib/judgingAccess";
import { assignJudge, listSubmissionsForJudge, loadSubmissionForJudge, resolveEntrantForUser, saveJudgeScores, setJudgingStatus, submitJudgeReview, submitSubmission } from "@/lib/core/judging";
import { content, createEvent, createJudge, createTeam, createUser, criterion, joinTeam, judgingSession, openWindow, organisationId, organiser, organiserId, orgSlug, register, setUpJudgingSuite, submissionIdFor, suffix, tearDownJudgingSuite, teamAuth } from "./helpers/judging";

// docs/HACKATHON.md "Tests", judges: the JUDGE-only grant and conflicts of interest. Shared setup: tests/integration/helpers/judging.ts.
const { as } = judgingSession(authMock);

describe.sequential("hackathon judging integration", () => {
  beforeAll(setUpJudgingSuite);

  afterAll(tearDownJudgingSuite);

  // -------------------------------------------------------------------------
  // Judges
  // -------------------------------------------------------------------------

  it("gives a JUDGE-only collaborator the judging workspace and nothing else", async () => {
    const event = await createEvent();
    const other = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const { teamId } = await createTeam(event, `Judged ${suffix}`);
    await submitSubmission(await teamAuth(teamId), content);
    const judge = await createJudge(event);

    // No other permission check treats JUDGE as its grant.
    for (const permission of Object.values(EventPermission).filter((p) => p !== EventPermission.JUDGE)) {
      expect(await canAccessEvent({ userId: judge.userId, organisationId, eventId: event.id, permission }), permission).toBe(false);
    }
    expect(await canAccessEvent({ userId: judge.userId, organisationId, eventId: event.id, permission: EventPermission.JUDGE })).toBe(true);
    const grant = await prisma.eventCollaborator.findFirstOrThrow({ where: { eventId: event.id, userId: judge.userId } });
    expect(judgingPermissionsFor(false, false, grant.permissions)).toEqual({ canJudge: true, canManageJudging: false, isJudgeOnly: true });

    // No organiser read models: guests, teams, judging setup.
    expect(await resolveJudgingOrganiser(judge.userId, orgSlug, event.id)).toBeNull();
    expect(await resolveOrganiserEvent(judge.userId, orgSlug, event.id)).toBeNull();

    // Not another event: no judge context, no workspace, no submission by id.
    expect(await resolveJudgeContext(judge.userId, orgSlug, other.id)).toBeNull();
    expect(await canAccessEvent({ userId: judge.userId, organisationId, eventId: other.id, permission: EventPermission.JUDGE })).toBe(false);
    await openWindow(await organiser(other));
    const { teamId: otherTeam } = await createTeam(other, `Elsewhere ${suffix}`);
    await submitSubmission(await teamAuth(otherTeam), content);
    const otherSubmission = await submissionIdFor({ teamId: otherTeam });
    expect(await listSubmissionsForJudge({ ...judge.ctx, eventId: other.id })).toBeNull();
    expect(await loadSubmissionForJudge(judge.ctx, otherSubmission)).toBeNull();

    // The workspace shows project content only: no emails, answers, tickets, or reasons.
    const workspace = await listSubmissionsForJudge(judge.ctx);
    expect(workspace?.submissions.map((s) => s.title)).toEqual([content.title]);
    const serialised = JSON.stringify([workspace, await loadSubmissionForJudge(judge.ctx, await submissionIdFor({ teamId }))]);
    expect(serialised).not.toMatch(/@example\.test|checkInToken|ticket|manageToken|joinToken|guestEmail|answers|disqualifiedReason/i);

    // Main's permission model (docs/PERMISSIONS.md): no registration, check-in
    // list, email draft, webhook, or export surface accepts a JUDGE-only grant.
    expect(await canManageRegistrationsFor({ userId: judge.userId, organisationId, eventId: event.id })).toBe(false);
    expect(eventCapabilities(null, grant.permissions)).toMatchObject({
      canJudge: true,
      isJudgeOnly: true,
      canManageJudging: false,
      canManageRegistrations: false,
      canExportAttendees: false,
      canViewAnalytics: false,
      canCheckIn: false,
      canCheckInToLists: false,
      canManageCheckInLists: false,
      canSendEmails: false,
      canEditPageContent: false,
      canManageCollaborators: false,
    });
    const someone = await register(event, "guest");
    const ref = { organisationSlug: orgSlug, eventId: event.id };
    expect(await as(judge.userId, () => approveRsvp({ ...ref, rsvpId: someone.rsvpId }))).toMatchObject({ ok: false });
    expect(await as(judge.userId, () => reacceptRsvp({ ...ref, rsvpId: someone.rsvpId }))).toMatchObject({ ok: false });
    expect(await as(judge.userId, () => deleteRsvp({ ...ref, rsvpId: someone.rsvpId }))).toMatchObject({ ok: false });
    expect(await createCheckInListForUser(judge.userId, { ...ref, name: "Swag" })).toEqual({ ok: false, error: "You do not have permission to manage check-in lists." });
    const list = await prisma.checkInList.create({ data: { eventId: event.id, name: `Lunch ${suffix}` } });
    expect(await checkInToListForUser(judge.userId, { ...ref, listId: list.id, rsvpId: someone.rsvpId })).toEqual({ ok: false, error: "You do not have permission to operate check-in." });
    expect(await lookupListAttendeesForUser(judge.userId, { ...ref, listId: list.id, query: "guest" })).toMatchObject({ ok: false });
    expect(await prisma.checkInListRecord.count({ where: { listId: list.id } })).toBe(0);
    const draft = { ...ref, subject: "Hi", body: "<p>Hi</p>", design: "minimal", statuses: ["CONFIRMED"], attendance: "ANY", templateId: null };
    expect(await as(judge.userId, () => saveEventBroadcastDraft(draft))).toMatchObject({ ok: false });
    expect(await as(judge.userId, () => loadEventBroadcastDraft(ref))).toMatchObject({ ok: false });
    expect(await prisma.eventBroadcastDraft.count({ where: { eventId: event.id } })).toBe(0);
    expect(canManageWebhooks(await getMembership(judge.userId, organisationId))).toBe(false);
    authMock.mockResolvedValue({ user: { id: judge.userId } });
    try {
      const response = await exportAttendees(new Request("https://events.example.test/api/exports"), { params: Promise.resolve({ eventId: event.id }) });
      expect(response.status).toBe(404);
    } finally {
      authMock.mockResolvedValue(null);
    }

    // Revoking the grant closes the workspace immediately, even with an old context.
    await prisma.eventCollaborator.delete({ where: { id: grant.id } });
    expect(await resolveJudgeContext(judge.userId, orgSlug, event.id)).toBeNull();
    expect(await listSubmissionsForJudge(judge.ctx)).toBeNull();
  });

  it("hides conflicted submissions from judges and refuses their scores", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const judge = await createJudge(event, "conflicted");

    // The judge's account is a member (not leader) of one team.
    const { teamId: ownTeam } = await createTeam(event, `Own ${suffix}`);
    await joinTeam(event, ownTeam, { userId: judge.userId });
    const { teamId: fairTeam } = await createTeam(event, `Fair ${suffix}`);
    for (const teamId of [ownTeam, fairTeam]) expect(await submitSubmission(await teamAuth(teamId), content)).toMatchObject({ ok: true });
    const ownSubmission = await submissionIdFor({ teamId: ownTeam });
    const fairSubmission = await submissionIdFor({ teamId: fairTeam });

    // An org admin judging their own solo registration is conflicted too.
    const soloEvent = await createEvent({ registrationMode: RegistrationMode.INDIVIDUAL });
    const soloCtx = await organiser(soloEvent);
    await openWindow(soloCtx);
    const adminSolo = await register(soloEvent, "admin", { userId: organiserId });
    const adminEntrant = await resolveEntrantForUser(organiserId, soloEvent.id);
    expect(adminEntrant).toMatchObject({ kind: "solo-owner", rsvpId: adminSolo.rsvpId });
    expect(await submitSubmission(adminEntrant!, { title: "Admin project" })).toMatchObject({ ok: true });
    const adminJudge = await resolveJudgeContext(organiserId, orgSlug, soloEvent.id);
    expect(adminJudge).toMatchObject({ isAdmin: true });
    expect((await listSubmissionsForJudge(adminJudge!))?.submissions).toEqual([]);

    const c = await criterion(ctx, { name: "Impact", weight: 1, maxScore: 5 });
    expect(await setJudgingStatus(ctx, JudgingStatus.OPEN)).toMatchObject({ ok: true });

    const visible = (await listSubmissionsForJudge(judge.ctx))?.submissions.map((s) => s.id);
    expect(visible).toEqual([fairSubmission]);
    expect(await loadSubmissionForJudge(judge.ctx, ownSubmission)).toBeNull();
    expect(await saveJudgeScores(judge.ctx, { submissionId: ownSubmission, scores: [{ criterionId: c, score: 5 }] })).toMatchObject({ ok: false, error: "Submission not found." });
    expect(await submitJudgeReview(judge.ctx, { submissionId: ownSubmission, comment: "Mine!", submit: false })).toMatchObject({ ok: false });
    expect(await assignJudge(ctx, { judgeUserId: judge.userId, submissionId: ownSubmission })).toMatchObject({ ok: false, error: "This judge is registered on this entry, so they can't judge it." });
    expect(await prisma.judgeScore.count({ where: { submissionId: ownSubmission } })).toBe(0);
    expect(await prisma.judgeReview.count({ where: { submissionId: ownSubmission } })).toBe(0);

    // With per-judge assignment, unassigned submissions are hidden and unscorable.
    await openWindow(ctx, { judgesSeeAll: false });
    expect((await listSubmissionsForJudge(judge.ctx))?.submissions).toEqual([]);
    expect(await saveJudgeScores(judge.ctx, { submissionId: fairSubmission, scores: [{ criterionId: c, score: 4 }] })).toMatchObject({ ok: false });
    expect(await assignJudge(ctx, { judgeUserId: judge.userId, submissionId: fairSubmission })).toMatchObject({ ok: true });
    expect((await listSubmissionsForJudge(judge.ctx))?.submissions.map((s) => s.id)).toEqual([fairSubmission]);
    expect(await saveJudgeScores(judge.ctx, { submissionId: fairSubmission, scores: [{ criterionId: c, score: 4 }] })).toMatchObject({ ok: true });
    // Someone with no judging grant cannot be assigned.
    const outsider = await createUser("outsider");
    expect(await assignJudge(ctx, { judgeUserId: outsider.id, submissionId: fairSubmission })).toMatchObject({ ok: false, error: "This person is not a judge for this event." });
  });
});
