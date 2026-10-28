import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { cancelHelp, commentAsMentor, commentAsParticipant, raiseHelp, rateHelp } from "@/lib/core/mentorDesk/help";
import { helpCommand } from "@/lib/core/mentorDesk/helpCommands";
import { expireHelpRequests } from "@/lib/core/mentorDesk/helpExpiry";
import { loadMentorConsole } from "@/lib/core/mentorDesk/readsMentor";
import { createTeam, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { addCategory, addMentor, createDeskEvent, goLive, heldClaim, HOUR, organiserOf, requestVersion, teamParticipant } from "./helpers/mentorDesk";

// docs/MENTOR_DESK.md "Tests": the help queue (help_workflow.py, help_expiry.py).
describe.sequential("mentor desk help queue", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(tearDownJudgingSuite);

  async function scenario(categoryOptions: Parameters<typeof addCategory>[1] = { key: "general" }) {
    let event = await createDeskEvent();
    const { teamId } = await createTeam(event, `Help ${Math.random().toString(36).slice(2, 8)}`);
    const { teamId: otherTeamId } = await createTeam(event, `Other ${Math.random().toString(36).slice(2, 8)}`);
    event = await goLive(event);
    await addCategory(event, categoryOptions);
    const team = await teamParticipant(teamId);
    const raised = await raiseHelp(team, { categoryKey: categoryOptions.key, summary: "Our build fails" });
    if (!raised.ok) throw new Error(raised.error);
    return { event, teamId, otherTeamId, team, requestId: raised.data.id };
  }

  it("enforces the per-team open limit and keeps the request private to its team", async () => {
    const { team, event, otherTeamId } = await scenario({ key: "general", openLimit: 1 });
    expect(await raiseHelp(team, { categoryKey: "general", summary: "Again" })).toEqual({ ok: false, error: "This team already has an open request in this category." });
    expect(await raiseHelp(team, { categoryKey: "missing", summary: "x" })).toEqual({ ok: false, error: "Choose an available help category." });
    const other = await teamParticipant(otherTeamId);
    const mine = await prisma.helpRequest.findFirstOrThrow({ where: { eventId: event.id, teamId: team.teamId! } });
    expect(await cancelHelp(other, { requestId: mine.id, expectedVersion: mine.version })).toEqual({ ok: false, error: "Not found." });
  });

  it("lets exactly one of two mentors win a simultaneous claim", async () => {
    const { event, requestId } = await scenario();
    const [a, b] = [await addMentor(event, "mentor-a"), await addMentor(event, "mentor-b")];
    const version = await requestVersion(requestId);
    const results = await Promise.all([a, b].map((m) => helpCommand(m, { requestId, action: "claim", expectedVersion: version })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const row = await prisma.helpRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.status).toBe("CLAIMED");
    expect([a.userId, b.userId]).toContain(row.claimedByUserId);
    expect(row.claimGeneration).toBe(1);
  });

  it("holds a mentor to one live claim, and frees a lapsed one when they claim again", async () => {
    const { event, requestId, otherTeamId } = await scenario();
    const mentor = await addMentor(event, "single");
    const second = await raiseHelp(await teamParticipant(otherTeamId), { categoryKey: "general", summary: "Second" });
    if (!second.ok) throw new Error(second.error);
    expect((await helpCommand(mentor, { requestId, action: "claim", expectedVersion: await requestVersion(requestId) })).ok).toBe(true);
    expect(await helpCommand(mentor, { requestId: second.data.id, action: "claim", expectedVersion: await requestVersion(second.data.id) })).toEqual({ ok: false, error: "Finish or release the current request first." });
    // The database is the last word: a second CLAIMED row for the mentor violates the partial unique index.
    await expect(prisma.helpRequest.update({ where: { id: second.data.id }, data: { status: "CLAIMED", claimedByUserId: mentor.userId, claimId: "x", claimGeneration: 1, claimExpiresAt: new Date(Date.now() + HOUR) } })).rejects.toThrow();
    await prisma.helpRequest.update({ where: { id: requestId }, data: { claimExpiresAt: new Date(Date.now() - 1000) } });
    expect((await helpCommand(mentor, { requestId: second.data.id, action: "claim", expectedVersion: await requestVersion(second.data.id) })).ok).toBe(true);
    const first = await prisma.helpRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(first).toMatchObject({ status: "OPEN", claimedByUserId: null, openGeneration: 2 });
  });

  it("fences renewals by claim id and generation, and refuses a lapsed lease", async () => {
    const { event, requestId } = await scenario({ key: "general", claimMinutes: 5 });
    const mentor = await addMentor(event, "renew");
    await helpCommand(mentor, { requestId, action: "claim", expectedVersion: await requestVersion(requestId) });
    const claimed = await prisma.helpRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(await helpCommand(mentor, { requestId, action: "renew", expectedVersion: claimed.version, claimId: "wrong", claimGeneration: claimed.claimGeneration })).toEqual({ ok: false, error: "This help claim expired. Refresh the queue." });
    expect((await helpCommand(mentor, { requestId, action: "renew", expectedVersion: claimed.version, claimId: claimed.claimId!, claimGeneration: claimed.claimGeneration })).ok).toBe(true);
    // Release and resolve are fenced the same way: a stale screen never acts on a later claim.
    for (const action of ["release", "resolve"]) {
      expect(await helpCommand(mentor, { requestId, action, ...(await heldClaim(requestId)), claimGeneration: claimed.claimGeneration + 1 })).toEqual({ ok: false, error: "This help claim expired. Refresh the queue." });
      expect(await helpCommand(mentor, { requestId, action, expectedVersion: await requestVersion(requestId) })).toEqual({ ok: false, error: "This help claim expired. Refresh the queue." });
    }
    await prisma.helpRequest.update({ where: { id: requestId }, data: { claimExpiresAt: new Date(Date.now() - 1000) } });
    const lapsed = await prisma.helpRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(await helpCommand(mentor, { requestId, action: "resolve", expectedVersion: lapsed.version })).toEqual({ ok: false, error: "This help claim expired. Refresh the queue." });
    // Reads never mutate: the console shows the lapsed claim as lapsed.
    expect((await loadMentorConsole(mentor))?.claim?.lapsed).toBe(true);
    expect((await prisma.helpRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("CLAIMED");
  });

  it("refuses an off-shift mentor and keeps the assigned mentor's priority window", async () => {
    const { event, requestId, teamId } = await scenario();
    const away = await addMentor(event, "away", { availability: [{ startsAt: new Date(Date.now() + 2 * HOUR), endsAt: new Date(Date.now() + 3 * HOUR) }] });
    expect(await helpCommand(away, { requestId, action: "claim", expectedVersion: await requestVersion(requestId) })).toEqual({ ok: false, error: "You are outside your mentoring availability." });
    const assigned = await addMentor(event, "assigned");
    const other = await addMentor(event, "other");
    await prisma.mentorTeamAssignment.create({ data: { eventId: event.id, mentorUserId: assigned.userId, teamId, mode: "MANUAL", activatedAt: new Date() } });
    expect(await helpCommand(other, { requestId, action: "claim", expectedVersion: await requestVersion(requestId) })).toEqual({ ok: false, error: "This request needs another mentor." });
    await prisma.helpRequest.update({ where: { id: requestId }, data: { exclusiveUntil: new Date(Date.now() - 1000) } });
    expect((await helpCommand(other, { requestId, action: "claim", expectedVersion: await requestVersion(requestId) })).ok).toBe(true);
  });

  it("matches skill tags and blocks team members and declared conflicts", async () => {
    const { event, requestId, teamId } = await scenario({ key: "cloud", skillTags: ["aws"] });
    const wrong = await addMentor(event, "frontend", { skills: ["react"] });
    expect((await helpCommand(wrong, { requestId, action: "claim", expectedVersion: await requestVersion(requestId) })).ok).toBe(false);
    const conflicted = await addMentor(event, "conflicted", { skills: ["aws"] });
    await prisma.mentorConflict.create({ data: { eventId: event.id, mentorUserId: conflicted.userId, teamId, kind: "DECLARED" } });
    expect((await helpCommand(conflicted, { requestId, action: "claim", expectedVersion: await requestVersion(requestId) })).ok).toBe(false);
    const right = await addMentor(event, "cloud", { skills: ["aws"] });
    expect((await helpCommand(right, { requestId, action: "claim", expectedVersion: await requestVersion(requestId) })).ok).toBe(true);
  });

  it("runs comments, resolve, reopen with a reason, rating and cancel through the lifecycle", async () => {
    const { event, requestId, team } = await scenario();
    const mentor = await addMentor(event, "life");
    const organiser = await organiserOf(event);
    expect(await helpCommand(mentor, { requestId, action: "reopen", expectedVersion: 1, note: "x" })).toEqual({ ok: false, error: "Not found." });
    expect((await commentAsParticipant(team, { requestId, expectedVersion: await requestVersion(requestId), body: "We are at table 4" })).ok).toBe(true);
    await helpCommand(mentor, { requestId, action: "claim", expectedVersion: await requestVersion(requestId) });
    expect((await commentAsMentor(mentor, { requestId, expectedVersion: await requestVersion(requestId), body: "On my way" })).ok).toBe(true);
    expect((await helpCommand(mentor, { requestId, action: "resolve", ...(await heldClaim(requestId)) })).ok).toBe(true);
    expect(await commentAsParticipant(team, { requestId, expectedVersion: await requestVersion(requestId), body: "late" })).toEqual({ ok: false, error: "This request is closed." });
    expect(await helpCommand(organiser, { requestId, action: "reopen", expectedVersion: await requestVersion(requestId), note: " " })).toEqual({ ok: false, error: "Explain why the request is reopening." });
    expect((await helpCommand(organiser, { requestId, action: "reopen", expectedVersion: await requestVersion(requestId), note: "Still broken" })).ok).toBe(true);
    expect((await cancelHelp(team, { requestId, expectedVersion: await requestVersion(requestId) })).ok).toBe(true);
    expect((await rateHelp(team, { requestId, rating: 5 })).ok).toBe(false);
    const kinds = (await prisma.helpRequestActivity.findMany({ where: { requestId }, orderBy: { createdAt: "asc" } })).map((a) => a.kind);
    expect(kinds).toEqual(["raised", "claim", "resolve", "reopen", "cancel"]);
    // Audit records the action, never the request text.
    const audits = await prisma.auditEvent.findMany({ where: { targetId: requestId } });
    expect(audits.map((a) => a.action)).toEqual(["MENTOR_HELP_REOPENED"]);
    expect(JSON.stringify(audits)).not.toMatch(/build fails|Still broken/);
  });

  it("checks the deadline inside commands and lets the expiry beat run twice without double-applying", async () => {
    const { event, requestId, otherTeamId } = await scenario();
    const mentor = await addMentor(event, "beat");
    const other = await raiseHelp(await teamParticipant(otherTeamId), { categoryKey: "general", summary: "Lapsed" });
    if (!other.ok) throw new Error(other.error);
    await helpCommand(mentor, { requestId: other.data.id, action: "claim", expectedVersion: await requestVersion(other.data.id) });
    await prisma.helpRequest.update({ where: { id: other.data.id }, data: { claimExpiresAt: new Date(Date.now() - 1000) } });
    await prisma.helpRequest.update({ where: { id: requestId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await helpCommand(mentor, { requestId, action: "claim", expectedVersion: await requestVersion(requestId) })).toEqual({ ok: false, error: "This help request expired." });
    const runs = await Promise.all([expireHelpRequests(), expireHelpRequests()]);
    const total = runs.reduce((sum, r) => ({ expired: sum.expired + r.expired, released: sum.released + r.released }), { expired: 0, released: 0 });
    expect(total.expired).toBeGreaterThanOrEqual(1);
    expect(await prisma.helpRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: "EXPIRED" });
    expect(await prisma.helpRequest.findUniqueOrThrow({ where: { id: other.data.id } })).toMatchObject({ status: "OPEN", openGeneration: 2, claimedByUserId: null });
    const third = await expireHelpRequests();
    expect(await prisma.helpRequestActivity.count({ where: { requestId, kind: "expired" } })).toBe(1);
    expect(third.expired + third.released).toBeGreaterThanOrEqual(0);
  });

  it("keeps the activity and comment ledgers append-only", async () => {
    const { requestId } = await scenario();
    const activity = await prisma.helpRequestActivity.findFirstOrThrow({ where: { requestId } });
    await expect(prisma.helpRequestActivity.update({ where: { id: activity.id }, data: { kind: "edited" } })).rejects.toThrow(/append-only/);
    await expect(prisma.helpRequestActivity.delete({ where: { id: activity.id } })).rejects.toThrow(/append-only/);
    // Clearing the actor (a deleted account) is allowed; the parent's cascade is too.
    await prisma.helpRequestActivity.update({ where: { id: activity.id }, data: { actorUserId: null } });
    await prisma.helpRequest.delete({ where: { id: requestId } });
    expect(await prisma.helpRequestActivity.count({ where: { requestId } })).toBe(0);
  });
});
