import { EventPrivacyType, EventStatus, RegistrationMode, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Registration decisions taken under the locks they depend on:
 * - invite-only public registration is re-checked under the reservation's
 *   lock: an audience switched to invite-only while a registration waits is
 *   refused, and only the signed-in invitee gets their one place;
 * - joining or moving into a team re-reads the check-in state under the
 *   registration's row lock (check-in takes only that lock);
 * - a cancelled event confirms no team, whoever promotes it.
 */

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));

import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { joinTeamWithExistingRsvp, organiserMoveMember, transitionTeamStatus } from "@/lib/core/teams";
import { whileLocked } from "./helpers/paymentAudit";
import { createEvent, createTeam, organisationId, organiser, orgSlug, registerOk, seekerHolder, setUpTeams, statusOf, suffix, tearDownTeams } from "./helpers/teams";

beforeAll(() => setUpTeams());
afterAll(() => tearDownTeams());

const users: string[] = [];
async function account(label: string) {
  const user = await prisma.user.create({ data: { email: `${label}-${suffix}@example.test`, name: `${label} Person`, emailVerified: new Date() } });
  users.push(user.id);
  return user;
}
afterAll(() => prisma.user.deleteMany({ where: { id: { in: users } } }));

/** The organiser switches the audience to invite-only while holding the Event lock; `work` waits behind it. */
const switchedWhile = <T>(eventId: string, work: () => Promise<T>) => whileLocked(async (tx) => {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
  await tx.event.update({ where: { id: eventId }, data: { privacyType: EventPrivacyType.INVITE_ONLY } });
}, work);

describe.sequential("invite-only registration under the reservation lock", () => {
  it("refuses a guest whose registration waited while the audience became invite-only", async () => {
    const event = await createEvent({ registrationMode: RegistrationMode.INDIVIDUAL });
    const guestEmail = `waiting-guest-${suffix}@example.test`;
    const result = await switchedWhile(event.id, () => submitRsvpCore({ orgSlug, eventSlug: event.slug, guestEmail, name: "Waiting Guest", answers: {} }, { userId: null }));
    expect(result).toEqual({ ok: false, error: "This event is invite-only. Sign in with the invited account to register." });
    expect(await prisma.rSVP.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("refuses a signed-in account that is not invited, under the same race", async () => {
    const event = await createEvent({ registrationMode: RegistrationMode.INDIVIDUAL });
    const user = await account("not-invited");
    const result = await switchedWhile(event.id, () => submitRsvpCore({ orgSlug, eventSlug: event.slug, answers: {} }, { userId: user.id }));
    expect(result).toEqual({ ok: false, error: "This event is invite-only. Use the email you were invited with." });
    expect(await prisma.rSVP.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("gives the signed-in invitee their one place", async () => {
    const event = await createEvent({ registrationMode: RegistrationMode.INDIVIDUAL });
    const user = await account("invited");
    await prisma.eventInvite.create({ data: { eventId: event.id, email: user.email! } });
    const result = await switchedWhile(event.id, () => submitRsvpCore({ orgSlug, eventSlug: event.slug, answers: {} }, { userId: user.id }));
    expect(result).toMatchObject({ ok: true, data: { status: RsvpStatus.CONFIRMED } });
    expect(await prisma.rSVP.findMany({ where: { eventId: event.id }, select: { userId: true, attendeeKey: true } })).toEqual([{ userId: user.id, attendeeKey: `user:${user.id}` }]);
  });

  it("refuses a guest on a series date whose audience became invite-only meanwhile", async () => {
    const series = await prisma.eventSeries.create({ data: { organisationId, title: "Invite race series", slug: `invite-race-${suffix}`, recurrenceRule: "FREQ=WEEKLY;COUNT=1", timezone: "UTC", status: EventStatus.PUBLISHED } });
    const date = await prisma.eventInstance.create({ data: { eventSeriesId: series.id, startDateTime: new Date("2035-02-01T10:00:00.000Z"), endDateTime: new Date("2035-02-01T12:00:00.000Z") } });
    const result = await whileLocked(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "EventSeries" WHERE "id" = ${series.id} FOR UPDATE`;
      await tx.eventSeries.update({ where: { id: series.id }, data: { privacyType: EventPrivacyType.INVITE_ONLY } });
    }, () => submitRsvpCore({ orgSlug, eventInstanceId: date.id, guestEmail: `series-guest-${suffix}@example.test`, name: "Series Guest", answers: {} }, { userId: null }));
    expect(result).toEqual({ ok: false, error: "This event is invite-only. Sign in with the invited account to register." });
    expect(await prisma.rSVP.count({ where: { eventInstanceId: date.id } })).toBe(0);
  });
});

/** The check-in commits while the team change waits for the registration's row lock. */
const checkedInWhile = <T>(rsvpId: string, work: () => Promise<T>) => whileLocked((tx) => tx.rSVP.update({ where: { id: rsvpId }, data: { checkedInAt: new Date() } }), work);

/** A capacity-one event: confirmed solo A, then waitlisted teams C (older) and B. */
async function fullEventWithWaitlistedTeams() {
  const event = await createEvent({ capacity: 1 });
  const solo = await registerOk(event, "solo");
  const older = await createTeam(event, `Older ${suffix.slice(0, 6)}`);
  const newer = await createTeam(event, `Newer ${suffix.slice(0, 6)}`);
  expect([solo.status, older.team.status, newer.team.status]).toEqual([RsvpStatus.CONFIRMED, RsvpStatus.WAITLISTED, RsvpStatus.WAITLISTED]);
  return { event, solo, older, newer };
}

describe.sequential("team changes racing a check-in", () => {
  it("refuses a checked-in solo joining a waitlisted team, and its unit stays taken", async () => {
    const { solo, older, newer } = await fullEventWithWaitlistedTeams();
    const holder = await seekerHolder(solo.ticketToken);
    const result = await checkedInWhile(solo.rsvpId, () => joinTeamWithExistingRsvp(holder, newer.team.joinToken));
    expect(result).toEqual({ ok: false, error: "This registration has already checked in, so it can only join a team that has a place." });
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: solo.rsvpId } })).toMatchObject({ teamId: null, status: RsvpStatus.CONFIRMED });
    expect(await statusOf(older.leader.rsvpId)).toBe(RsvpStatus.WAITLISTED);
  });

  it("refuses an organiser moving a just-checked-in solo into a waitlisted team", async () => {
    const { event, solo, older, newer } = await fullEventWithWaitlistedTeams();
    const ctx = await organiser(event);
    const result = await checkedInWhile(solo.rsvpId, () => organiserMoveMember(ctx, { rsvpId: solo.rsvpId, targetTeamId: newer.team.id }));
    expect(result).toEqual({ ok: false, error: "This person has already checked in, so they can only move to a confirmed team." });
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: solo.rsvpId } })).toMatchObject({ teamId: null, status: RsvpStatus.CONFIRMED });
    expect(await statusOf(older.leader.rsvpId)).toBe(RsvpStatus.WAITLISTED);
  });
});

describe.sequential("whole-team promotion on a cancelled event", () => {
  it("refuses to promote a waitlisted team once the event is cancelled", async () => {
    const event = await createEvent({ capacity: 1 });
    const first = await createTeam(event, `First ${suffix.slice(0, 6)}`);
    const waiting = await createTeam(event, `Waiting ${suffix.slice(0, 6)}`);
    expect(waiting.team.status).toBe(RsvpStatus.WAITLISTED);
    const ctx = await organiser(event);
    // Cancelled, with the place free again.
    await prisma.event.update({ where: { id: event.id }, data: { status: EventStatus.CANCELLED, capacity: 2 } });
    expect(await transitionTeamStatus(ctx, waiting.team.id, "promote")).toEqual({ ok: false, error: "This event has been cancelled, so no team can be confirmed." });
    expect(await statusOf(waiting.leader.rsvpId)).toBe(RsvpStatus.WAITLISTED);
    expect(await statusOf(first.leader.rsvpId)).toBe(RsvpStatus.CONFIRMED);
  });
});
