import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ value: null as null | { user: { id: string }; mfaVerified?: boolean } }));
vi.mock("@/lib/auth", () => ({ auth: async () => session.value }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { EventPermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { canAccessEvent, canManageRegistrationsFor } from "@/lib/eventAccess";
import { eventCapabilities } from "@/lib/eventDashboard/capabilities";
import { resolveJudgeContext, resolveJudgingOrganiser } from "@/lib/judgingAccess";
import { createEventCollaboratorToken, hashEventCollaboratorToken } from "@/lib/eventCollaboratorToken";
import { acceptEventCollaboratorInviteToken } from "@/lib/inviteAcceptance";
import { resolveDeskOrganiser, resolveMentorContext, resolveParticipantForUser } from "@/lib/core/mentorDesk/access";
import { saveMentorProfile } from "@/lib/core/mentorDesk/configuration";
import { syncMentorGrantLocked } from "@/lib/core/mentorDesk/grant";
import { raiseHelp } from "@/lib/core/mentorDesk/help";
import { helpCommand } from "@/lib/core/mentorDesk/helpCommands";
import { createTeam, createUser, organisationId, organiserId, orgSlug, otherOrganisationId, otherOrganiserId, register, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { addCategory, addMentor, createDeskEvent, goLive, organiserOf, slugOf, teamParticipant } from "./helpers/mentorDesk";

// docs/MENTOR_DESK.md "Tests": MENTOR isolation, staff MFA, tenancy and the grant lifecycle.
describe.sequential("mentor desk permissions", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(tearDownJudgingSuite);

  it("isolates MENTOR: no other permission check accepts it, and it opens only the mentor console", async () => {
    const event = await goLive(await createDeskEvent());
    const mentor = await addMentor(event, "isolated");
    for (const permission of Object.values(EventPermission).filter((p) => p !== EventPermission.MENTOR)) {
      expect(await canAccessEvent({ userId: mentor.userId, organisationId, eventId: event.id, permission }), permission).toBe(false);
    }
    expect(await canManageRegistrationsFor({ userId: mentor.userId, organisationId, eventId: event.id })).toBe(false);
    expect(await resolveJudgeContext(mentor.userId, orgSlug, event.id)).toBeNull();
    expect(await resolveJudgingOrganiser(mentor.userId, orgSlug, event.id)).toBeNull();
    expect(await resolveDeskOrganiser(mentor.userId, orgSlug, event.id)).toBeNull();
    expect(eventCapabilities(null, [EventPermission.MENTOR])).toMatchObject({ canMentor: true, isMentorOnly: true, canManageMentorDesk: false, canManageRegistrations: false, canCheckIn: false, canJudge: false, isJudgeOnly: false });
    expect(eventCapabilities(null, [EventPermission.MENTOR, EventPermission.JUDGE])).toMatchObject({ isMentorOnly: true, canJudge: true });
    expect(eventCapabilities(null, [EventPermission.MENTOR, EventPermission.CHECK_IN]).isMentorOnly).toBe(false);
  });

  it("requires the staff authenticator check for mentors", async () => {
    const event = await goLive(await createDeskEvent());
    const mentor = await addMentor(event, "mfa");
    vi.stubEnv("STAFF_MFA_REQUIRED", "true");
    try {
      session.value = { user: { id: mentor.userId } };
      expect(await resolveMentorContext(mentor.userId, orgSlug, event.id)).toBeNull();
      await prisma.user.update({ where: { id: mentor.userId }, data: { mfaEnabledAt: new Date() } });
      expect(await resolveMentorContext(mentor.userId, orgSlug, event.id)).toBeNull();
      session.value = { user: { id: mentor.userId }, mfaVerified: true };
      expect(await resolveMentorContext(mentor.userId, orgSlug, event.id)).not.toBeNull();
    } finally {
      session.value = null;
      vi.stubEnv("STAFF_MFA_REQUIRED", "false");
    }
  });

  it("keeps organisations and events apart", async () => {
    const event = await goLive(await createDeskEvent());
    const other = await goLive(await createDeskEvent({ organisation: otherOrganisationId }));
    const mentor = await addMentor(event, "tenant");
    expect(await resolveMentorContext(mentor.userId, slugOf(other), other.id)).toBeNull();
    expect(await resolveMentorContext(mentor.userId, slugOf(other), event.id)).toBeNull();
    expect(await resolveDeskOrganiser(otherOrganiserId, slugOf(other), event.id)).toBeNull();
    expect(await resolveDeskOrganiser(organiserId, orgSlug, other.id)).toBeNull();
    // A request id from another event is not found through this event's context.
    await prisma.helpCategory.create({ data: { eventId: other.id, key: "general", label: "General" } });
    const { teamId } = await createTeam(await prisma.event.update({ where: { id: other.id }, data: { startDateTime: new Date(Date.now() + 3_600_000) } }), "Elsewhere");
    await goLive(other);
    const raised = await raiseHelp(await teamParticipant(teamId), { categoryKey: "general", summary: "Other org" });
    if (!raised.ok) throw new Error(raised.error);
    expect(await helpCommand(await organiserOf(event), { requestId: raised.data.id, action: "reopen", expectedVersion: 1, note: "x" })).toEqual({ ok: false, error: "Not found." });
    expect(await helpCommand(mentor, { requestId: raised.data.id, action: "claim", expectedVersion: 1 })).toEqual({ ok: false, error: "Not found." });
  });

  it("lets only a signed-in confirmed registrant raise help, and nobody when the desk is off", async () => {
    const event = await createDeskEvent();
    const user = await createUser("attendee");
    await register(event, "attendee", { userId: user.id });
    const stranger = await createUser("stranger");
    await goLive(event);
    await addCategory(event, { key: "general" });
    expect(await resolveParticipantForUser(stranger.id, orgSlug, event.id)).toBeNull();
    const participant = await resolveParticipantForUser(user.id, orgSlug, event.id);
    expect(participant).toMatchObject({ kind: "account", teamId: null });
    expect((await raiseHelp(participant!, { categoryKey: "general", summary: "Solo help" })).ok).toBe(true);
    await prisma.event.update({ where: { id: event.id }, data: { mentorDeskEnabled: false } });
    expect(await resolveParticipantForUser(user.id, orgSlug, event.id)).toBeNull();
    expect(await raiseHelp(participant!, { categoryKey: "general", summary: "Again" })).toEqual({ ok: false, error: "The Mentor Desk is off for this event." });
  });

  it("creates the profile on invite acceptance and ends assignments and claims when the grant goes", async () => {
    const event = await goLive(await createDeskEvent());
    const user = await createUser("invited");
    const token = createEventCollaboratorToken();
    await prisma.eventCollaboratorInvite.create({ data: { eventId: event.id, email: user.email!, tokenHash: hashEventCollaboratorToken(token), permissions: [EventPermission.MENTOR], createdByUserId: organiserId, expiresAt: new Date(Date.now() + 3_600_000) } });
    expect((await acceptEventCollaboratorInviteToken(token, { id: user.id, email: user.email! })).ok).toBe(true);
    const profile = await prisma.mentorProfile.findUniqueOrThrow({ where: { eventId_userId: { eventId: event.id, userId: user.id } } });
    const ctx = await resolveMentorContext(user.id, orgSlug, event.id);
    expect((await saveMentorProfile(ctx!, { mentorUserId: user.id, expectedVersion: profile.version, skills: ["Python", "python"], availability: [{ start: "2000-01-01T00:00", end: "2000-01-01T01:00" }] })).ok).toBe(false);
    // A mentor cannot edit another mentor's profile.
    const other = await addMentor(event, "other-profile");
    expect(await saveMentorProfile(ctx!, { mentorUserId: other.userId, expectedVersion: 1, bio: "x" })).toEqual({ ok: false, error: "Not found." });
    // Removing the grant ends live mappings.
    const { teamId } = await createTeam(await prisma.event.update({ where: { id: event.id }, data: { startDateTime: new Date(Date.now() + 3_600_000) } }), "Grant team");
    await prisma.mentorTeamAssignment.create({ data: { eventId: event.id, mentorUserId: user.id, teamId, mode: "MANUAL", activatedAt: new Date() } });
    await prisma.$transaction((tx) => syncMentorGrantLocked(tx, event.id, user.id, [EventPermission.MENTOR], [], organiserId));
    expect(await prisma.mentorTeamAssignment.findFirstOrThrow({ where: { eventId: event.id, mentorUserId: user.id } })).toMatchObject({ status: "ENDED" });
  });
});
