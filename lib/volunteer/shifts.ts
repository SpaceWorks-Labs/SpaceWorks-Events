import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { enqueueVolunteerNotice } from "@/lib/outbox/volunteer";
import { lockCrewPersons, requirePersonsLocked, retryWhenPersonsChange } from "@/lib/personLock";
import { promoteLocked } from "./signups";
import { NOT_FOUND, PEOPLE_CHANGED, approvedCount, fail, hasBookedOfficeHourBetween, hasOverlappingDuty, lockCrewMembers, lockShift, shiftInputSchema, type VolunteerResult, type VolunteerStaff } from "./shared";

/*
 * Shift setup (docs/VOLUNTEERS.md): organisers with the crew rule create,
 * edit, close and delete shifts. Capacity never drops below the approved
 * places, the window is fixed once work has started, and more room or a
 * reopened shift promotes the waitlist first in, first out. An edit locks
 * everyone it may touch once, up front (docs/VOLUNTEERS.md "Locks"):
 * their person locks, the shift, then all their crew rows in one batch, so
 * two edits with crossed rosters wait for each other instead of deadlocking.
 */

const MAX_SHIFTS = 200;

/** The crew members waiting on a shift and, with `holders`, those with a place. */
async function rosterIds(tx: Prisma.TransactionClient, eventId: string, shiftId: string, holders: boolean) {
  const rows = await tx.volunteerShiftSignup.findMany({ where: { shiftId, eventId, status: { in: holders ? ["APPROVED", "WAITLISTED"] : ["WAITLISTED"] } }, select: { crewMemberId: true } });
  return rows.map((row) => row.crewMemberId);
}

/** Person locks, the shift, then the roster's crew rows in one batch; refuses (to retry) when the roster gained an unlocked person. */
async function lockShiftAndRoster(tx: Prisma.TransactionClient, eventId: string, shiftId: string, holders: boolean) {
  const people = await lockCrewPersons(tx, eventId, await rosterIds(tx, eventId, shiftId, holders));
  const shift = await lockShift(tx, eventId, shiftId);
  if (!shift) return null;
  const roster = await rosterIds(tx, eventId, shift.id, holders);
  await lockCrewMembers(tx, eventId, roster);
  await requirePersonsLocked(tx, eventId, roster, people);
  return shift;
}

async function staffEvent(staff: VolunteerStaff) {
  return prisma.event.findFirst({ where: { id: staff.eventId, organisationId: staff.organisationId }, select: { id: true, status: true } });
}

export async function setVolunteerShiftsEnabled(staff: VolunteerStaff, enabled: boolean): Promise<VolunteerResult> {
  const updated = await prisma.event.updateMany({ where: { id: staff.eventId, organisationId: staff.organisationId }, data: { volunteerShiftsEnabled: enabled } });
  return updated.count === 1 ? { ok: true, data: undefined } : fail("Event not found.");
}

export async function createShift(staff: VolunteerStaff, input: unknown): Promise<VolunteerResult<{ id: string }>> {
  const parsed = shiftInputSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the shift details.");
  const event = await staffEvent(staff);
  if (!event) return fail("Event not found.");
  if (event.status === "CANCELLED") return fail("This event is cancelled.");
  if ((await prisma.volunteerShift.count({ where: { eventId: event.id } })) >= MAX_SHIFTS) return fail(`An event can have up to ${MAX_SHIFTS} shifts.`);
  const shift = await prisma.volunteerShift.create({ data: { eventId: event.id, ...parsed.data }, select: { id: true } });
  return { ok: true, data: shift };
}

export async function updateShift(staff: VolunteerStaff, shiftId: string, input: unknown, now = new Date()): Promise<VolunteerResult> {
  const parsed = shiftInputSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the shift details.");
  if (!(await staffEvent(staff))) return fail("Event not found.");
  const data = parsed.data;
  return retryWhenPersonsChange(() => prisma.$transaction(async (tx): Promise<VolunteerResult> => {
    // The people with a place (checked against a new window) and the waitlist (more room promotes it).
    const shift = await lockShiftAndRoster(tx, staff.eventId, shiftId, true);
    if (!shift) return fail(NOT_FOUND);
    const approved = await approvedCount(tx, shift.id);
    if (data.capacity !== 0 && data.capacity < approved) return fail(`${approved} volunteers already have a place. Remove some before lowering the places.`);
    const windowChanged = data.startsAt.getTime() !== shift.startsAt.getTime() || data.endsAt.getTime() !== shift.endsAt.getTime() || data.graceMinutes !== shift.graceMinutes;
    if (windowChanged && (await tx.volunteerShiftSignup.count({ where: { shiftId: shift.id, attendance: { not: "SCHEDULED" } } })) > 0) {
      return fail("Work has started on this shift, so its times can no longer change.");
    }
    if (windowChanged) {
      // Everyone with a place keeps one duty at a time: the new window must not overlap their other approved shifts or their booked office hours.
      const holders = await tx.volunteerShiftSignup.findMany({ where: { shiftId: shift.id, status: "APPROVED" }, select: { crewMemberId: true } });
      const window = { id: shift.id, startsAt: data.startsAt, endsAt: data.endsAt };
      let clashes = 0;
      for (const { crewMemberId: id } of holders) if ((await hasOverlappingDuty(tx, id, window)) || (await hasBookedOfficeHourBetween(tx, staff.eventId, id, window))) clashes += 1;
      if (clashes > 0) return fail(`${clashes === 1 ? "1 volunteer" : `${clashes} volunteers`} with a place would then overlap another of their shifts or a booked office hour. Cancel those places or choose other times.`);
    }
    const updated = await tx.volunteerShift.update({ where: { id: shift.id }, data });
    await promoteLocked(tx, updated, staff.organisationId, now);
    return { ok: true, data: undefined };
  }), fail(PEOPLE_CHANGED));
}

/** Closed shifts take no sign-ups, approvals or promotions; reopening promotes the waitlist. */
export async function setShiftClosed(staff: VolunteerStaff, shiftId: string, closed: boolean, now = new Date()): Promise<VolunteerResult> {
  if (!(await staffEvent(staff))) return fail("Event not found.");
  return retryWhenPersonsChange(() => prisma.$transaction(async (tx): Promise<VolunteerResult> => {
    // Reopening promotes the waitlist, so it is locked like an edit.
    const shift = closed ? await lockShift(tx, staff.eventId, shiftId) : await lockShiftAndRoster(tx, staff.eventId, shiftId, false);
    if (!shift) return fail(NOT_FOUND);
    const updated = await tx.volunteerShift.update({ where: { id: shift.id }, data: { closed } });
    if (!closed) await promoteLocked(tx, updated, staff.organisationId, now);
    return { ok: true, data: undefined };
  }), fail(PEOPLE_CHANGED));
}

/**
 * Deletes a shift nobody has worked yet. Volunteers with a place or on the
 * waitlist are told it is cancelled. A shift with attendance or hours stays:
 * close it instead.
 */
export async function deleteShift(staff: VolunteerStaff, shiftId: string): Promise<VolunteerResult> {
  if (!(await staffEvent(staff))) return fail("Event not found.");
  return prisma.$transaction(async (tx): Promise<VolunteerResult> => {
    const shift = await lockShift(tx, staff.eventId, shiftId);
    if (!shift) return fail(NOT_FOUND);
    if ((await tx.volunteerShiftSignup.count({ where: { shiftId: shift.id, attendance: { not: "SCHEDULED" } } })) > 0) {
      return fail("Volunteers have worked or been marked on this shift, so it keeps its record. Close it instead.");
    }
    const notify = await tx.volunteerShiftSignup.findMany({
      where: { shiftId: shift.id, status: { in: ["APPROVED", "WAITLISTED"] } },
      select: { crewMemberId: true, crewMember: { select: { email: true } } },
    });
    await tx.volunteerShift.delete({ where: { id: shift.id } });
    const snapshot = { title: shift.title, zone: shift.zone, startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString() };
    for (const row of notify) {
      await enqueueVolunteerNotice(tx, { to: row.crewMember.email, organisationId: staff.organisationId, notice: "cancelled", crewMemberId: row.crewMemberId, shift: snapshot });
    }
    return { ok: true, data: undefined };
  });
}
