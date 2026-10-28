import { JudgingStatus, RsvpStatus, SubmissionStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => vi.fn(async (): Promise<{ user: { id: string } } | null> => null));
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { joinTeamWithExistingRsvp, organiserDeleteTeam, organiserMoveMember, resolveOrganiserEvent, resolveRsvpByTicketToken, respondToJoinRequest } from "@/lib/core/teams";
import { deleteRsvp, restoreRsvp } from "@/app/actions/rsvp-admin";
import { createEventAward, disqualifySubmission, loadJudgingResults, saveJudgeScores, saveSubmissionDraft, setAwardWinner, setJudgingStatus, submitJudgeReview, submitSubmission, withdrawSubmission } from "@/lib/core/judging";
import { HOUR, content, createEvent, createJudge, createTeam, criterion, joinTeam, judgingSession, openWindow, organisationId, organiser, organiserId, orgSlug, register, setUpJudgingSuite, soloAuth, submissionIdFor, suffix, tearDownJudgingSuite, teamAuth } from "./helpers/judging";

// docs/HACKATHON.md "Tests", the entrant lifecycle: joining teams, project links, and undo. Shared setup: tests/integration/helpers/judging.ts.
const { as } = judgingSession(authMock);

describe.sequential("hackathon judging integration", () => {
  beforeAll(setUpJudgingSuite);

  afterAll(tearDownJudgingSuite);

  // -------------------------------------------------------------------------
  // Entrant lifecycle (an entrant is a team or one RSVP, never both)
  // -------------------------------------------------------------------------

  it("never carries a solo project into a team the registrant joins", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const teamsCtx = await resolveOrganiserEvent(organiserId, orgSlug, event.id);
    const { teamId } = await createTeam(event, `Joiners ${suffix}`);

    // A SUBMITTED solo project blocks joining (entrant side) and an organiser move.
    const solo = await register(event, "solo");
    const soloEntrant = await soloAuth(solo.rsvpId, event.id);
    expect(await submitSubmission(soloEntrant, { title: "Solo project" })).toMatchObject({ ok: true });
    const invite = await prisma.teamJoinRequest.create({ data: { teamId, rsvpId: solo.rsvpId, direction: "INVITE" } });
    const holder = await resolveRsvpByTicketToken(solo.ticketToken, null);
    const accept = () => respondToJoinRequest({ actor: { kind: "seeker", holder: holder! }, requestId: invite.id, accept: true });
    expect(await accept()).toMatchObject({ ok: false, error: expect.stringContaining("Withdraw that project") });
    expect(await organiserMoveMember(teamsCtx!, { rsvpId: solo.rsvpId, targetTeamId: teamId })).toMatchObject({ ok: false, error: expect.stringContaining("disqualify it") });
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: solo.rsvpId } })).toMatchObject({ teamId: null });

    // Once withdrawn, joining discards the solo project and retires its link.
    expect(await withdrawSubmission(soloEntrant)).toMatchObject({ ok: true });
    expect(await accept()).toMatchObject({ ok: true, data: { accepted: true } });
    expect(await prisma.submission.count({ where: { rsvpId: solo.rsvpId } })).toBe(0);
    expect(await prisma.submissionLink.count({ where: { rsvpId: solo.rsvpId } })).toBe(0);
    expect(await saveSubmissionDraft(soloEntrant, content)).toMatchObject({ ok: false });

    // A DISQUALIFIED solo project can't be shed by joining, but an organiser move removes it.
    const other = await register(event, "other");
    const otherEntrant = await soloAuth(other.rsvpId, event.id);
    expect(await submitSubmission(otherEntrant, { title: "Copied project" })).toMatchObject({ ok: true });
    const copied = await submissionIdFor({ rsvpId: other.rsvpId });
    expect(await disqualifySubmission(ctx, { submissionId: copied, reason: "Copied" })).toMatchObject({ ok: true });
    const otherInvite = await prisma.teamJoinRequest.create({ data: { teamId, rsvpId: other.rsvpId, direction: "INVITE" } });
    const otherHolder = await resolveRsvpByTicketToken(other.ticketToken, null);
    expect(await respondToJoinRequest({ actor: { kind: "seeker", holder: otherHolder! }, requestId: otherInvite.id, accept: true })).toMatchObject({ ok: false, error: expect.stringContaining("disqualified") });
    expect(await organiserMoveMember(teamsCtx!, { rsvpId: other.rsvpId, targetTeamId: teamId })).toMatchObject({ ok: true });
    expect(await prisma.submission.count({ where: { id: copied } })).toBe(0);
    expect(await prisma.submissionLink.count({ where: { rsvpId: other.rsvpId } })).toBe(0);

    // Only the team's own project remains for this event's entrants.
    expect(await submitSubmission(await teamAuth(teamId), { title: "Team project" })).toMatchObject({ ok: true });
    expect((await prisma.submission.findMany({ where: { eventId: event.id } })).map((row) => row.teamId)).toEqual([teamId]);
  });

  it("applies the solo project rules when a solo registrant joins a team by link", async () => {
    await prisma.webhookEndpoint.create({
      data: {
        organisationId,
        url: "https://hooks.example.test/judging",
        eventTypes: ["registration.status_changed"],
        secretEncrypted: "v1.placeholder.placeholder.placeholder",
      },
    });
    const since = new Date();
    const statusHooksFor = async (rsvpId: string) => {
      await flushWebhookEmits();
      const rows = await prisma.webhookDelivery.findMany({ where: { organisationId, eventType: "registration.status_changed", createdAt: { gte: since } } });
      return rows.filter((row) => (row.payload as { data: { registration: { id: string } } }).data.registration.id === rsvpId);
    };
    try {
      // One unit: the solo registrant is confirmed, the team waits.
      const event = await createEvent({ capacity: 1 });
      const ctx = await organiser(event);
      await openWindow(ctx);
      const solo = await register(event, "link-solo");
      expect(solo.status).toBe(RsvpStatus.CONFIRMED);
      const { teamId } = await createTeam(event, `Linkers ${suffix}`);
      const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId } });
      const holder = await resolveRsvpByTicketToken(solo.ticketToken, null);
      if (!holder) throw new Error("ticket did not resolve");

      // A SUBMITTED solo project blocks the join; nothing moves or is emitted.
      const soloEntrant = await soloAuth(solo.rsvpId, event.id);
      expect(await submitSubmission(soloEntrant, { title: "Solo by link" })).toMatchObject({ ok: true });
      expect(await joinTeamWithExistingRsvp(holder, team.joinToken)).toMatchObject({ ok: false, error: expect.stringContaining("Withdraw that project") });
      expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: solo.rsvpId } })).toMatchObject({ teamId: null, status: RsvpStatus.CONFIRMED });
      expect(await prisma.submission.findFirstOrThrow({ where: { rsvpId: solo.rsvpId } })).toMatchObject({ status: SubmissionStatus.SUBMITTED });
      expect(await statusHooksFor(solo.rsvpId)).toHaveLength(0);

      // Withdrawn: the join discards the solo project and retires its link,
      // and the status webhooks are still sent after the transaction commits.
      expect(await withdrawSubmission(soloEntrant)).toMatchObject({ ok: true });
      expect(await joinTeamWithExistingRsvp(holder, team.joinToken)).toMatchObject({ ok: true, data: { teamName: team.name } });
      expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: solo.rsvpId } })).toMatchObject({ teamId });
      expect(await prisma.submission.count({ where: { rsvpId: solo.rsvpId } })).toBe(0);
      expect(await prisma.submissionLink.count({ where: { rsvpId: solo.rsvpId } })).toBe(0);
      expect(await saveSubmissionDraft(soloEntrant, content)).toMatchObject({ ok: false });
      expect((await statusHooksFor(solo.rsvpId)).length).toBeGreaterThan(0);

      // A DISQUALIFIED solo project can't be shed by joining with a link either.
      const open = await createEvent();
      const openCtx = await organiser(open);
      await openWindow(openCtx);
      const { teamId: openTeamId } = await createTeam(open, `Open linkers ${suffix}`);
      const openTeam = await prisma.team.findUniqueOrThrow({ where: { id: openTeamId } });
      const flagged = await register(open, "link-flagged");
      expect(await submitSubmission(await soloAuth(flagged.rsvpId, open.id), { title: "Flagged" })).toMatchObject({ ok: true });
      expect(await disqualifySubmission(openCtx, { submissionId: await submissionIdFor({ rsvpId: flagged.rsvpId }), reason: "Copied" })).toMatchObject({ ok: true });
      const flaggedHolder = await resolveRsvpByTicketToken(flagged.ticketToken, null);
      expect(await joinTeamWithExistingRsvp(flaggedHolder!, openTeam.joinToken)).toMatchObject({ ok: false, error: expect.stringContaining("disqualified") });
      expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: flagged.rsvpId } })).toMatchObject({ teamId: null });

      // A draft is simply discarded.
      const drafter = await register(open, "link-drafter");
      expect(await saveSubmissionDraft(await soloAuth(drafter.rsvpId, open.id), content)).toMatchObject({ ok: true });
      const drafterHolder = await resolveRsvpByTicketToken(drafter.ticketToken, null);
      expect(await joinTeamWithExistingRsvp(drafterHolder!, openTeam.joinToken)).toMatchObject({ ok: true });
      expect(await prisma.submission.count({ where: { rsvpId: drafter.rsvpId } })).toBe(0);
    } finally {
      await prisma.webhookEndpoint.deleteMany({ where: { organisationId } });
    }
  });

  it("stores project links in canonical https:// form", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const { teamId } = await createTeam(event, `Caps ${suffix}`);
    // An auto-capitalised scheme and a slashless one both satisfy the database CHECK.
    expect(await submitSubmission(await teamAuth(teamId), { title: "Caps", repoUrl: "HTTPS://GitHub.com/acme/app", demoUrl: "https:demo.example.test/x" })).toMatchObject({ ok: true });
    expect(await prisma.submission.findFirstOrThrow({ where: { teamId } })).toMatchObject({ repoUrl: "https://github.com/acme/app", demoUrl: "https://demo.example.test/x" });
  });

  it("restores a deleted team's project and judging record on undo", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const teamsCtx = await resolveOrganiserEvent(organiserId, orgSlug, event.id);
    const { teamId } = await createTeam(event, `Undo ${suffix}`);
    expect(await submitSubmission(await teamAuth(teamId), { title: "Undo me" })).toMatchObject({ ok: true });
    const submissionId = await submissionIdFor({ teamId });
    const c = await criterion(ctx, { name: "Impact", weight: 1, maxScore: 10 });
    const judge = await createJudge(event, "undo-judge");
    await setJudgingStatus(ctx, JudgingStatus.OPEN);
    expect(await saveJudgeScores(judge.ctx, { submissionId, scores: [{ criterionId: c, score: 7 }] })).toMatchObject({ ok: true });
    expect(await submitJudgeReview(judge.ctx, { submissionId, comment: "Solid" })).toMatchObject({ ok: true });
    const award = await createEventAward(ctx, { name: "Overall winner" });
    if (!award.ok) throw new Error(award.error);
    expect(await setAwardWinner(ctx, { awardId: award.data.id, submissionId, place: 1 })).toMatchObject({ ok: true });

    const deleted = await organiserDeleteTeam(teamsCtx!, teamId);
    if (!deleted.ok || !deleted.data) throw new Error("delete failed");
    expect(await prisma.submission.count({ where: { id: submissionId } })).toBe(0);
    expect(await as(organiserId, () => restoreRsvp({ organisationSlug: orgSlug, undoId: deleted.data!.undoId }))).toEqual({ ok: true });
    expect(await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } })).toMatchObject({ teamId, status: SubmissionStatus.SUBMITTED, title: "Undo me" });
    expect(await prisma.judgeScore.findMany({ where: { submissionId }, select: { judgeUserId: true, score: true } })).toEqual([{ judgeUserId: judge.userId, score: 7 }]);
    expect(await prisma.judgeReview.findFirstOrThrow({ where: { submissionId } })).toMatchObject({ comment: "Solid", submittedAt: expect.any(Date) });
    expect(await prisma.eventAwardWinner.count({ where: { submissionId, place: 1 } })).toBe(1);
    expect((await loadJudgingResults(ctx))?.rows[0]).toMatchObject({ submissionId, score: 70, judgesCounted: 1 });

    // A solo registration's project survives a delete and undo too (new RSVP id).
    const solo = await register(event, "solo-undo");
    expect(await submitSubmission(await soloAuth(solo.rsvpId, event.id), { title: "Solo undo" })).toMatchObject({ ok: true });
    const soloSubmission = await submissionIdFor({ rsvpId: solo.rsvpId });
    const removed = await as(organiserId, () => deleteRsvp({ organisationSlug: orgSlug, eventId: event.id, rsvpId: solo.rsvpId }));
    if (!removed.ok || !removed.data) throw new Error("rsvp delete failed");
    expect(await prisma.submission.count({ where: { id: soloSubmission } })).toBe(0);
    expect(await as(organiserId, () => restoreRsvp({ organisationSlug: orgSlug, undoId: removed.data!.undoId }))).toEqual({ ok: true });
    const restored = await prisma.submission.findUniqueOrThrow({ where: { id: soloSubmission }, include: { rsvp: true } });
    expect(restored).toMatchObject({ title: "Solo undo", status: SubmissionStatus.SUBMITTED });
    expect(restored.rsvp?.attendeeKey).toBeTruthy();
  });

  it("restores the project, judging record, and check-in list records from one team undo snapshot", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    await openWindow(ctx);
    const teamsCtx = await resolveOrganiserEvent(organiserId, orgSlug, event.id);
    const c = await criterion(ctx, { name: "Craft", weight: 1, maxScore: 10 });
    const judge = await createJudge(event, "snapshot-judge");
    const swag = await prisma.checkInList.create({ data: { eventId: event.id, name: `Swag ${suffix}` } });
    const at = new Date(Date.now() - HOUR);

    async function teamWithEverything(name: string) {
      const { teamId, leader } = await createTeam(event, name);
      const member = await joinTeam(event, teamId);
      expect(await submitSubmission(await teamAuth(teamId), { title: name })).toMatchObject({ ok: true });
      const submissionId = await submissionIdFor({ teamId });
      await prisma.checkInListRecord.createMany({ data: [
        { listId: swag.id, rsvpId: leader.rsvpId, source: "mobile-scan", checkedInAt: at },
        { listId: swag.id, rsvpId: member.rsvpId, source: "online", checkedInAt: at },
      ] });
      return { teamId, submissionId, rsvpIds: [leader.rsvpId, member.rsvpId] };
    }
    async function deleteTeam(teamId: string) {
      const deleted = await organiserDeleteTeam(teamsCtx!, teamId);
      if (!deleted.ok || !deleted.data) throw new Error("delete failed");
      return deleted.data.undoId;
    }
    const restore = (undoId: string) => as(organiserId, () => restoreRsvp({ organisationSlug: orgSlug, undoId }));

    // Current format: both the judging record and the list records come back.
    await setJudgingStatus(ctx, JudgingStatus.OPEN);
    const full = await teamWithEverything(`Snapshot full ${suffix}`);
    expect(await saveJudgeScores(judge.ctx, { submissionId: full.submissionId, scores: [{ criterionId: c, score: 6 }] })).toMatchObject({ ok: true });
    const undoId = await deleteTeam(full.teamId);
    const payload = (await prisma.rsvpDeletionUndo.findUniqueOrThrow({ where: { id: undoId } })).payload as { submission?: unknown; rsvps: Array<{ listCheckIns?: unknown[] }> };
    expect(payload.submission).toBeTruthy();
    expect(payload.rsvps.every((rsvp) => rsvp.listCheckIns?.length === 1)).toBe(true);
    expect(await restore(undoId)).toEqual({ ok: true });
    expect(await prisma.submission.findUniqueOrThrow({ where: { id: full.submissionId } })).toMatchObject({ teamId: full.teamId, status: SubmissionStatus.SUBMITTED });
    expect(await prisma.judgeScore.count({ where: { submissionId: full.submissionId, score: 6 } })).toBe(1);
    expect((await prisma.checkInListRecord.findMany({ where: { listId: swag.id, rsvpId: { in: full.rsvpIds } }, select: { rsvpId: true } })).map((row) => row.rsvpId).sort()).toEqual([...full.rsvpIds].sort());

    // Older formats still restore: team registration's (no project, no list
    // records) and the judging branch's (project, no list records).
    for (const keepSubmission of [false, true]) {
      const older = await teamWithEverything(`Snapshot ${keepSubmission ? "judging" : "teams"} ${suffix}`);
      const id = await deleteTeam(older.teamId);
      const row = await prisma.rsvpDeletionUndo.findUniqueOrThrow({ where: { id } });
      const legacy = structuredClone(row.payload) as Record<string, unknown> & { rsvps: Array<Record<string, unknown>> };
      if (!keepSubmission) delete legacy.submission;
      for (const rsvp of legacy.rsvps) delete rsvp.listCheckIns;
      await prisma.rsvpDeletionUndo.update({ where: { id }, data: { payload: legacy as never } });
      expect(await restore(id)).toEqual({ ok: true });
      expect(await prisma.rSVP.count({ where: { teamId: older.teamId } })).toBe(2);
      expect(await prisma.checkInListRecord.count({ where: { rsvpId: { in: older.rsvpIds } } })).toBe(0);
      expect(await prisma.submission.count({ where: { id: older.submissionId } })).toBe(keepSubmission ? 1 : 0);
    }
  });
});
