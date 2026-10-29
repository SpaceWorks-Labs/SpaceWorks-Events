import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { type Event } from "@prisma/client";
import { prisma } from "@/lib/db";
import { addCrewMemberAsOrganiser, moveCrewMember, updateCrewMemberAsOrganiser } from "@/lib/core/crew/members";
import { linkCrewAccount } from "@/lib/core/crew/shared";
import { CREW_LINK_CONFLICT, linkMentorCrew } from "@/lib/core/crew/identity";
import { syncMentorCrewAfterGrant } from "@/lib/core/mentorDesk/crewLink";
import { bookOfficeHour, createOfficeHourSlot } from "@/lib/core/mentorDesk/officeHours";
import { acceptEventCollaboratorInviteToken } from "@/lib/inviteAcceptance";
import { createEventCollaboratorToken, hashEventCollaboratorToken } from "@/lib/eventCollaboratorToken";
import { applyForShift } from "@/lib/volunteer/signups";
import { updateShift } from "@/lib/volunteer/shifts";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { createTeam, createUser, organiserId, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { fulfilled, holdLocks, lockWaiters, raceBehind, untilLockWaiters } from "./helpers/locks";
import { addMentor, createDeskEvent, goLive, local, teamParticipant } from "./helpers/mentorDesk";

describe.sequential("final lock-order regressions", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(async () => { await flushWebhookEmits(); await tearDownJudgingSuite(); });

  const MINUTE = 60_000;
  const at = (minutes: number) => new Date(Math.ceil((Date.now() + minutes * MINUTE) / MINUTE) * MINUTE);
  const ctx = (event: Event) => ({ organisationId: event.organisationId, eventId: event.id, actorUserId: organiserId });
  const staff = (event: Event) => ({ organisationId: event.organisationId, eventId: event.id, userId: organiserId, isAdmin: true });
  const holdEvent = (event: Event) => holdLocks((tx) => tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`);

  async function guest(event: Event, email = `final-${randomUUID()}@example.test`) {
    const added = await addCrewMemberAsOrganiser(ctx(event), { name: "Guest", email });
    if (!added.ok) throw new Error(added.error);
    return prisma.eventCrewMember.findUniqueOrThrow({ where: { id: added.data.id } });
  }

  async function invite(event: Event, person: { email: string | null }) {
    const token = createEventCollaboratorToken();
    const row = await prisma.eventCollaboratorInvite.create({ data: {
      eventId: event.id, email: person.email!, tokenHash: hashEventCollaboratorToken(token),
      permissions: ["CHECK_IN"], createdByUserId: organiserId, expiresAt: at(60),
    } });
    return { token, row };
  }

  it("accepts an invite alongside event deletion without an invite/Event cycle", async () => {
    const event = await createDeskEvent();
    const person = await createUser("delete-invite");
    const { token, row } = await invite(event, person);
    const [deleted, accepted] = await raceBehind(
      await holdEvent(event),
      () => prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`;
        return tx.event.deleteMany({ where: { id: event.id } });
      }),
      () => acceptEventCollaboratorInviteToken(token, { id: person.id, email: person.email! }),
    );
    expect(fulfilled(deleted)).toEqual({ count: 1 });
    expect(fulfilled(accepted)).toEqual({ ok: false, reason: "unavailable" });
    expect(await prisma.eventCollaboratorInvite.count({ where: { id: row.id } })).toBe(0);
    expect(await prisma.eventCollaborator.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("locks the whole crew in id order before reordering alongside a title-only shift edit", async () => {
    const event = await prisma.event.update({ where: { id: (await createDeskEvent()).id }, data: { volunteerShiftsEnabled: true } });
    const members = [await guest(event), await guest(event)].sort((a, b) => a.id.localeCompare(b.id));
    const [a, b] = members;
    await prisma.eventCrewMember.update({ where: { id: a!.id }, data: { sortOrder: 0 } });
    await prisma.eventCrewMember.update({ where: { id: b!.id }, data: { sortOrder: 1 } });
    const shift = await prisma.volunteerShift.create({ data: { eventId: event.id, title: "Desk", startsAt: at(60), endsAt: at(120), signupDeadline: at(60), requiresApproval: false } });
    for (const member of members) expect(await applyForShift({ eventId: event.id, crewMemberId: member.id }, shift.id)).toMatchObject({ ok: true });
    const [edited, moved] = await raceBehind(
      await holdLocks((tx) => tx.$queryRaw`SELECT "id" FROM "EventCrewMember" WHERE "id" IN (${a!.id}, ${b!.id}) ORDER BY "id" FOR UPDATE`),
      () => updateShift(staff(event), shift.id, {
        title: "New title", zone: shift.zone, task: shift.task, startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString(),
        signupDeadline: shift.signupDeadline.toISOString(), capacity: shift.capacity, waitlistEnabled: shift.waitlistEnabled, requiresApproval: shift.requiresApproval, graceMinutes: shift.graceMinutes,
      }),
      () => moveCrewMember(ctx(event), a!.id, 1),
    );
    expect(fulfilled(edited)).toMatchObject({ ok: true });
    expect(fulfilled(moved)).toMatchObject({ ok: true });
    expect((await prisma.eventCrewMember.findMany({ where: { eventId: event.id }, orderBy: { sortOrder: "asc" } })).map((m) => m.id)).toEqual([b!.id, a!.id]);
    expect((await prisma.volunteerShift.findUniqueOrThrow({ where: { id: shift.id } })).title).toBe("New title");
  });

  async function linkingFixture() {
    let event = await createDeskEvent();
    const { teamId } = await createTeam(event, `Link ${randomUUID().slice(0, 8)}`);
    event = await goLive(event);
    event = await prisma.event.update({ where: { id: event.id }, data: { volunteerShiftsEnabled: true } });
    const mentor = await addMentor(event, "link-duty");
    const user = await prisma.user.update({ where: { id: mentor.userId }, data: { emailVerified: new Date() } });
    const member = await guest(event);
    const duty = await prisma.volunteerShift.create({ data: { eventId: event.id, title: "Duty", startsAt: at(60), endsAt: at(120), signupDeadline: at(60), requiresApproval: false } });
    expect(await applyForShift({ eventId: event.id, crewMemberId: member.id }, duty.id)).toMatchObject({ ok: true });
    const made = await createOfficeHourSlot(mentor, { mentorUserId: mentor.userId, start: local(at(75)), end: local(at(105)) });
    if (!made.ok) throw new Error(made.error);
    const slot = await prisma.officeHourSlot.findUniqueOrThrow({ where: { id: made.data.id } });
    return { event, mentor, user, member, duty, slot, team: await teamParticipant(teamId) };
  }

  const book = (f: Awaited<ReturnType<typeof linkingFixture>>) => bookOfficeHour(f.team, { slotId: f.slot.id, expectedVersion: f.slot.version });
  const editEmail = (f: Awaited<ReturnType<typeof linkingFixture>>) => updateCrewMemberAsOrganiser(ctx(f.event), f.member.id, { name: "Linked", email: f.user.email! });

  it("refuses an email change that would link approved duties to booked office hours, without changing the member or ticket", async () => {
    const f = await linkingFixture();
    expect(await book(f)).toMatchObject({ ok: true });
    expect(await editEmail(f)).toEqual({ ok: false, error: CREW_LINK_CONFLICT });
    expect(await prisma.eventCrewMember.findUniqueOrThrow({ where: { id: f.member.id } })).toMatchObject({ email: f.member.email, userId: null });
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: f.member.rsvpId } })).toMatchObject({ guestEmail: f.member.email });
  });

  it("refuses both direct account linking and a mentor-profile link, including an unverified mentor", async () => {
    for (const direction of ["account", "profile"] as const) {
      const f = await linkingFixture();
      expect(await book(f)).toMatchObject({ ok: true });
      if (direction === "account") {
        await prisma.eventCrewMember.update({ where: { id: f.member.id }, data: { email: f.user.email! } });
        await expect(prisma.$transaction((tx) => linkCrewAccount(tx, f.user.id, f.user.email, f.event.id))).rejects.toThrow(CREW_LINK_CONFLICT);
      } else {
        await prisma.user.update({ where: { id: f.user.id }, data: { emailVerified: null } });
        await expect(prisma.$transaction((tx) => linkMentorCrew(tx, f.event.id, f.user.id, f.member.id))).rejects.toThrow(CREW_LINK_CONFLICT);
      }
      expect((await prisma.eventCrewMember.findUniqueOrThrow({ where: { id: f.member.id } })).userId).toBeNull();
      expect((await prisma.mentorProfile.findUniqueOrThrow({ where: { eventId_userId: { eventId: f.event.id, userId: f.user.id } } })).crewMemberId).toBeNull();
    }
  });

  it("rolls back an invite claim and grant when its account link would create a schedule conflict", async () => {
    const f = await linkingFixture();
    expect(await book(f)).toMatchObject({ ok: true });
    await prisma.eventCrewMember.update({ where: { id: f.member.id }, data: { email: f.user.email! } });
    const { token, row } = await invite(f.event, f.user);
    expect(await acceptEventCollaboratorInviteToken(token, { id: f.user.id, email: f.user.email! })).toMatchObject({ ok: false, error: CREW_LINK_CONFLICT });
    expect((await prisma.eventCollaboratorInvite.findUniqueOrThrow({ where: { id: row.id } })).usedAt).toBeNull();
    expect((await prisma.eventCollaborator.findUniqueOrThrow({ where: { eventId_userId: { eventId: f.event.id, userId: f.user.id } } })).permissions).toEqual(["MENTOR"]);
  });

  it("rechecks duty approved while the mentor crew hook waits to add its profile identity link", async () => {
    const f = await linkingFixture();
    expect(await book(f)).toMatchObject({ ok: true });
    await prisma.event.update({ where: { id: f.event.id }, data: { mentorsGetCrewTicket: true } });
    await prisma.user.update({ where: { id: f.user.id }, data: { emailVerified: null } });
    const barrier = await holdLocks((tx) => tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${f.user.id} FOR NO KEY UPDATE`);
    const baseline = await lockWaiters();
    const linking = syncMentorCrewAfterGrant({ eventId: f.event.id, userId: f.user.id, before: [], after: ["MENTOR"], actorUserId: organiserId })
      .then(() => ({ ok: true }), (error: unknown) => {
        if (error instanceof Error && error.message === CREW_LINK_CONFLICT) return { ok: false, error: error.message };
        throw error;
      });
    try {
      await Promise.race([untilLockWaiters(() => baseline + 1), linking.then(() => { throw new Error("The profile link did not wait for the person lock."); })]);
      const created = await prisma.eventCrewMember.findUniqueOrThrow({ where: { eventId_email: { eventId: f.event.id, email: f.user.email! } } });
      expect(created.userId).toBeNull();
      // The hook has committed its new crew ticket, but cannot yet associate its duties with this person.
      expect(await applyForShift({ eventId: f.event.id, crewMemberId: created.id }, f.duty.id)).toMatchObject({ ok: true, data: { status: "APPROVED" } });
    } finally {
      await barrier.release();
      await linking;
    }
    expect(await linking).toEqual({ ok: false, error: CREW_LINK_CONFLICT });
    expect((await prisma.mentorProfile.findUniqueOrThrow({ where: { eventId_userId: { eventId: f.event.id, userId: f.user.id } } })).crewMemberId).toBeNull();
  });

  it("serialises an email link behind a booking already waiting on the person lock", async () => {
    const f = await linkingFixture();
    const [booked, linked] = await raceBehind(
      await holdLocks((tx) => tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${f.user.id} FOR NO KEY UPDATE`),
      () => book(f),
      () => editEmail(f),
    );
    expect(fulfilled(booked)).toMatchObject({ ok: true });
    expect(fulfilled(linked)).toEqual({ ok: false, error: CREW_LINK_CONFLICT });
    expect((await prisma.eventCrewMember.findUniqueOrThrow({ where: { id: f.member.id } })).userId).toBeNull();
  });

  it("serialises both link directions against booking, whichever queues first", async () => {
    for (const direction of ["account", "profile"] as const) for (const first of ["booking", "link"] as const) {
      const f = await linkingFixture();
      if (direction === "account") await prisma.eventCrewMember.update({ where: { id: f.member.id }, data: { email: f.user.email! } });
      const link = () => prisma.$transaction(async (tx) => {
        try {
          const count = direction === "account"
            ? await linkCrewAccount(tx, f.user.id, f.user.email, f.event.id)
            : await linkMentorCrew(tx, f.event.id, f.user.id, f.member.id);
          return { ok: count === 1 };
        } catch (error) {
          if (error instanceof Error && error.message === CREW_LINK_CONFLICT) return { ok: false };
          throw error;
        }
      });
      // Both potential first rows are held: the old account link goes straight to crew.
      const barrier = await holdLocks(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${f.event.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "EventCrewMember" WHERE "id" = ${f.member.id} FOR UPDATE`;
      });
      const booking = async () => ({ ok: (await book(f)).ok });
      const commands = first === "booking" ? [booking, link] as const : [link, booking] as const;
      const results = await raceBehind(barrier, ...commands);
      expect(results.map((r) => fulfilled(r).ok)).toEqual([true, false]);
      const bookings = await prisma.officeHourBooking.count({ where: { slotId: f.slot.id, status: "BOOKED" } });
      const member = await prisma.eventCrewMember.findUniqueOrThrow({ where: { id: f.member.id } });
      const profile = await prisma.mentorProfile.findUniqueOrThrow({ where: { eventId_userId: { eventId: f.event.id, userId: f.user.id } } });
      expect(bookings === 1 && (member.userId === f.user.id || profile.crewMemberId === member.id)).toBe(false);
    }
  });

  it("allows back-to-back duty and ignores cancelled bookings when adding either identity link", async () => {
    for (const adjacent of [true, false]) {
      const f = await linkingFixture();
      expect(await book(f)).toMatchObject({ ok: true });
      if (adjacent) await prisma.volunteerShift.update({ where: { id: f.duty.id }, data: { endsAt: f.slot.startsAt } });
      else await prisma.officeHourBooking.updateMany({ where: { slotId: f.slot.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "participant" } });
      expect(await editEmail(f)).toMatchObject({ ok: true });
      expect(await prisma.$transaction((tx) => linkMentorCrew(tx, f.event.id, f.user.id, f.member.id))).toBe(1);
    }
  });
});
