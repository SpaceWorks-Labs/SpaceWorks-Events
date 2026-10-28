import type { Event } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { VolunteerSelf, VolunteerStaff } from "@/lib/volunteer/shared";
import { addCrew, createCrewEvent, crew } from "./crew";

/*
 * Shared setup for the volunteer shift suites (docs/VOLUNTEERS.md), on top of
 * the crew helpers: an event with shifts on, crew members, shifts placed
 * relative to now, and staff contexts. Callers mock `@/lib/auth`,
 * `@/lib/actionRateLimit` and `next/cache` first and call setUpCrewOrgs.
 */

const MINUTE = 60_000;

export async function shiftsEvent(options: { enabled?: boolean } = {}) {
  const event = await createCrewEvent();
  return prisma.event.update({ where: { id: event.id }, data: { volunteerShiftsEnabled: options.enabled ?? true } });
}

/** A shift starting `startIn` minutes from now (negative for the past), `length` minutes long. */
export async function makeShift(event: Event, options: { startIn?: number; length?: number; capacity?: number; requiresApproval?: boolean; waitlistEnabled?: boolean; graceMinutes?: number; title?: string } = {}) {
  const start = new Date(Date.now() + (options.startIn ?? 60) * MINUTE);
  const end = new Date(start.getTime() + (options.length ?? 120) * MINUTE);
  return prisma.volunteerShift.create({
    data: {
      eventId: event.id, title: options.title ?? "Registration desk", zone: "Hall A", task: "Badges",
      startsAt: start, endsAt: end, signupDeadline: start,
      capacity: options.capacity ?? 0, requiresApproval: options.requiresApproval ?? false,
      waitlistEnabled: options.waitlistEnabled ?? true, graceMinutes: options.graceMinutes ?? 15,
    },
  });
}

export function staffFor(event: Event, userId = crew.organiserId, isAdmin = true): VolunteerStaff {
  return { organisationId: event.organisationId, eventId: event.id, userId, isAdmin };
}

export async function volunteer(event: Event, overrides: Record<string, unknown> = {}) {
  const member = await addCrew(event, overrides);
  const self: VolunteerSelf = { eventId: event.id, crewMemberId: member.id };
  return { member, self };
}

/** A second organisation admin, so verification has a second person. */
export async function secondAdmin(label: string) {
  const user = await prisma.user.create({ data: { name: `Admin ${label}`, email: `admin-${label}-${crew.suffix}@example.test`, emailVerified: new Date() } });
  await prisma.membership.create({ data: { userId: user.id, organisationId: crew.organisationId, role: "ADMIN" } });
  return user;
}

/** Puts a checked-out attendance with pending hours straight into the database (times in the past). */
export async function workedHours(event: Event, crewMemberId: string, minutes: number, options: { startAgo?: number } = {}) {
  const startAgo = options.startAgo ?? 600;
  const start = new Date(Date.now() - startAgo * MINUTE);
  const shift = await prisma.volunteerShift.create({
    data: { eventId: event.id, title: "Worked shift", startsAt: start, endsAt: new Date(start.getTime() + 240 * MINUTE), signupDeadline: start },
  });
  const signup = await prisma.volunteerShiftSignup.create({
    data: { eventId: event.id, shiftId: shift.id, crewMemberId, status: "APPROVED", attendance: "CHECKED_OUT", checkedInAt: start, checkedOutAt: new Date(start.getTime() + minutes * MINUTE) },
  });
  return prisma.volunteerHours.create({ data: { eventId: event.id, signupId: signup.id, minutes } });
}

export function notices(crewMemberId: string, notice: string) {
  return prisma.outboxMessage.count({ where: { kind: "volunteer-notice", AND: [{ payload: { path: ["crewMemberId"], equals: crewMemberId } }, { payload: { path: ["notice"], equals: notice } }] } });
}

export async function tearDownUsers(ids: string[]) {
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}
