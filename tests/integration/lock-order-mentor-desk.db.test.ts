import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { EventPermission, type Event } from "@prisma/client";
import { prisma } from "@/lib/db";
import { createEventCollaboratorToken, hashEventCollaboratorToken } from "@/lib/eventCollaboratorToken";
import { acceptEventCollaboratorInviteToken } from "@/lib/inviteAcceptance";
import { revokeEventCollaborator, updateEventCollaboratorPermissions } from "@/app/actions/event-collaborators";
import { assignMentorManually } from "@/lib/core/mentorDesk/assignments";
import { raiseHelp } from "@/lib/core/mentorDesk/help";
import { helpCommand } from "@/lib/core/mentorDesk/helpCommands";
import { createOfficeHourSlot, rescheduleOfficeHourSlot } from "@/lib/core/mentorDesk/officeHours";
import type { MentorContext } from "@/lib/core/mentorDesk/access";
import { createTeam, createUser, organiserId, orgSlug, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { fulfilled, holdLocks, raceBehind } from "./helpers/locks";
import { addCategory, addMentor, createDeskEvent, goLive, HOUR, local, organiserOf, requestVersion, teamParticipant } from "./helpers/mentorDesk";

/*
 * docs/MENTOR_DESK.md "Lock order": the Event before the mentor's grant, so
 * schedule changes, grant changes, assignments and help reassignments never
 * wait for each other in a cycle. Each case holds the first lock of both
 * commands, queues them, and releases them together (helpers/locks.ts).
 */
describe.sequential("mentor desk lock order", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(tearDownJudgingSuite);

  async function setUp(teams = 1) {
    let event = await createDeskEvent();
    const teamIds: string[] = [];
    for (let i = 0; i < teams; i += 1) teamIds.push((await createTeam(event, `L${i} ${Math.random().toString(36).slice(2, 7)}`)).teamId);
    event = await goLive(event);
    return { event, teamIds, organiser: await organiserOf(event) };
  }

  /**
   * The Event FOR UPDATE. The assignment queues for it first; the grant-first
   * order would then take the grant and queue behind it, and once released
   * the assignment would wait for that grant: a cycle.
   */
  const holdEvent = (event: Event) => holdLocks((tx) => tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`);

  async function asOrganiser<T>(run: () => Promise<T>) {
    identity.id = organiserId;
    try { return await run(); } finally { identity.id = ""; }
  }

  async function slotFor(mentor: MentorContext, startIn: number) {
    const made = await createOfficeHourSlot(mentor, { mentorUserId: mentor.userId, start: local(new Date(Date.now() + startIn)), end: local(new Date(Date.now() + startIn + 30 * 60_000)) });
    if (!made.ok) throw new Error(made.error);
    return prisma.officeHourSlot.findUniqueOrThrow({ where: { id: made.data.id } });
  }

  it("creates and reschedules office hours alongside a manual assignment for the same mentor", async () => {
    const { event, teamIds, organiser } = await setUp(2);
    const mentor = await addMentor(event, "lock-slot");
    const [assigned, created] = await raceBehind(
      await holdEvent(event),
      () => assignMentorManually(organiser, { mentorUserId: mentor.userId, teamId: teamIds[0]! }),
      () => createOfficeHourSlot(mentor, { mentorUserId: mentor.userId, start: local(new Date(Date.now() + HOUR)), end: local(new Date(Date.now() + HOUR + 30 * 60_000)) }),
    );
    expect(fulfilled(created)).toMatchObject({ ok: true });
    expect(fulfilled(assigned)).toMatchObject({ ok: true });

    const slot = await prisma.officeHourSlot.findFirstOrThrow({ where: { mentorUserId: mentor.userId } });
    const [again, moved] = await raceBehind(
      await holdEvent(event),
      () => assignMentorManually(organiser, { mentorUserId: mentor.userId, teamId: teamIds[1]! }),
      () => rescheduleOfficeHourSlot(mentor, { slotId: slot.id, expectedVersion: slot.version, reason: "Room change", start: local(new Date(Date.now() + 2 * HOUR)), end: local(new Date(Date.now() + 2 * HOUR + 30 * 60_000)) }),
    );
    expect(fulfilled(moved)).toMatchObject({ ok: true });
    expect(fulfilled(again)).toMatchObject({ ok: true });
  });

  it("revokes a MENTOR grant alongside a manual assignment, which it then ends", async () => {
    for (const change of ["revoke", "permissions"] as const) {
      const { event, teamIds, organiser } = await setUp(1);
      const mentor = await addMentor(event, `lock-${change}`);
      await slotFor(mentor, HOUR);
      const grant = await prisma.eventCollaborator.findFirstOrThrow({ where: { eventId: event.id, userId: mentor.userId } });
      const input = { organisationSlug: orgSlug, eventId: event.id, collaboratorId: grant.id };
      const [assigned, removed] = await asOrganiser(async () => raceBehind(
        await holdEvent(event),
        () => assignMentorManually(organiser, { mentorUserId: mentor.userId, teamId: teamIds[0]! }),
        () => change === "revoke" ? revokeEventCollaborator(input) : updateEventCollaboratorPermissions({ ...input, permissions: [EventPermission.CHECK_IN] }),
      ));
      expect(fulfilled(assigned)).toMatchObject({ ok: true });
      expect(fulfilled(removed)).toEqual({ ok: true });
      // The assignment committed first, so the grant change ended it (and cancelled the slot).
      expect(await prisma.mentorTeamAssignment.count({ where: { eventId: event.id, endedAt: null } })).toBe(0);
      expect(await prisma.officeHourSlot.count({ where: { eventId: event.id, cancelledAt: null } })).toBe(0);
    }
  });

  it("grants MENTOR, by a permission change or an accepted invite, alongside an assignment naming that person", async () => {
    for (const change of ["permissions", "invite"] as const) {
      const { event, teamIds, organiser } = await setUp(1);
      // A collaborator without MENTOR: granting it creates their profile, which references the Event.
      const person = await createUser(`lock-grant-${change}`);
      const grant = await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: person.id, permissions: [EventPermission.CHECK_IN] } });
      const token = createEventCollaboratorToken();
      await prisma.eventCollaboratorInvite.create({ data: { eventId: event.id, email: person.email!, tokenHash: hashEventCollaboratorToken(token), permissions: [EventPermission.MENTOR], createdByUserId: organiserId, expiresAt: new Date(Date.now() + HOUR) } });
      const [assigned, granted] = await asOrganiser(async () => raceBehind(
        await holdEvent(event),
        () => assignMentorManually(organiser, { mentorUserId: person.id, teamId: teamIds[0]! }),
        () => change === "permissions"
          ? updateEventCollaboratorPermissions({ organisationSlug: orgSlug, eventId: event.id, collaboratorId: grant.id, permissions: [EventPermission.CHECK_IN, EventPermission.MENTOR] })
          : acceptEventCollaboratorInviteToken(token, { id: person.id, email: person.email! }),
      ));
      // The assignment queued first: the person was not a mentor yet.
      expect(fulfilled(assigned)).toEqual({ ok: false, error: "You are not a mentor on this event." });
      expect(fulfilled(granted)).toMatchObject({ ok: true });
      expect(await prisma.mentorProfile.count({ where: { eventId: event.id, userId: person.id } })).toBe(1);
    }
  });

  it("serialises crossed help reassignments: one wins, the other sees a stale request", async () => {
    const { event, teamIds, organiser } = await setUp(2);
    const categoryKey = "lock-help";
    await addCategory(event, { key: categoryKey, openLimit: 2 });
    const [m1, m2] = [await addMentor(event, "lock-m1"), await addMentor(event, "lock-m2")];
    const [t1, t2] = await Promise.all(teamIds.map(teamParticipant));
    const raise = async (team: typeof t1, mentor: MentorContext) => {
      const raised = await raiseHelp(team!, { categoryKey, summary: "Stuck" });
      if (!raised.ok) throw new Error(raised.error);
      const claimed = await helpCommand(mentor, { requestId: raised.data.id, action: "claim", expectedVersion: await requestVersion(raised.data.id) });
      if (!claimed.ok) throw new Error(claimed.error);
      // The lease lapses; the request's own deadline is still open.
      await prisma.helpRequest.update({ where: { id: raised.data.id }, data: { claimExpiresAt: new Date(Date.now() - 1000) } });
      return raised.data.id;
    };
    const a = await raise(t1, m1);
    const b = await raise(t2, m2);
    const [versionA, versionB] = [await requestVersion(a), await requestVersion(b)];
    // A to M2 releases M2's lapsed claim on B; B to M1 releases M1's on A.
    const [toM2, toM1] = await raceBehind(
      await holdLocks((tx) => tx.$queryRaw`SELECT "id" FROM "HelpRequest" WHERE "id" IN (${a}, ${b}) FOR UPDATE`),
      () => helpCommand(organiser, { requestId: a, action: "assign", mentorUserId: m2.userId, expectedVersion: versionA }),
      () => helpCommand(organiser, { requestId: b, action: "assign", mentorUserId: m1.userId, expectedVersion: versionB }),
    );
    expect([fulfilled(toM2), fulfilled(toM1)]).toEqual([{ ok: true, data: undefined }, { ok: false, error: "This was changed by someone else. Refresh and try again." }]);
    expect(await prisma.helpRequest.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ status: "CLAIMED", claimedByUserId: m2.userId });
    expect(await prisma.helpRequest.findUniqueOrThrow({ where: { id: b } })).toMatchObject({ status: "OPEN", claimedByUserId: null });
  });
});
