import "server-only";

import { prisma } from "@/lib/db";
import { enqueueVolunteerNotice } from "@/lib/outbox/volunteer";
import { promoteLocked } from "./signups";
import { NOT_FOUND, approvedCount, fail, hasOverlappingDuty, lockCrewMembers, lockShift, shiftInputSchema, type VolunteerResult, type VolunteerStaff } from "./shared";

/*
 * Shift setup (docs/VOLUNTEERS.md): organisers with the crew rule create,
 * edit, close and delete shifts. Capacity never drops below the approved
 * places, the window is fixed once work has started, and more room or a
 * reopened shift promotes the waitlist first in, first out.
 */

const MAX_SHIFTS = 200;

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
  return prisma.$transaction(async (tx): Promise<VolunteerResult> => {
    const shift = await lockShift(tx, staff.eventId, shiftId);
    if (!shift) return fail(NOT_FOUND);
    const approved = await approvedCount(tx, shift.id);
    if (data.capacity !== 0 && data.capacity < approved) return fail(`${approved} volunteers already have a place. Remove some before lowering the places.`);
    const windowChanged = data.startsAt.getTime() !== shift.startsAt.getTime() || data.endsAt.getTime() !== shift.endsAt.getTime() || data.graceMinutes !== shift.graceMinutes;
    if (windowChanged && (await tx.volunteerShiftSignup.count({ where: { shiftId: shift.id, attendance: { not: "SCHEDULED" } } })) > 0) {
      return fail("Work has started on this shift, so its times can no longer change.");
    }
    if (windowChanged) {
      // Everyone with a place keeps one duty at a time: the new window must not overlap their other approved shifts.
      const holders = await tx.volunteerShiftSignup.findMany({ where: { shiftId: shift.id, status: "APPROVED" }, select: { crewMemberId: true } });
      const ids = holders.map((row) => row.crewMemberId);
      await lockCrewMembers(tx, staff.eventId, ids);
      let clashes = 0;
      for (const id of ids) if (await hasOverlappingDuty(tx, id, { id: shift.id, startsAt: data.startsAt, endsAt: data.endsAt })) clashes += 1;
      if (clashes > 0) return fail(`${clashes === 1 ? "1 volunteer" : `${clashes} volunteers`} with a place would then overlap another of their shifts. Cancel those places or choose other times.`);
    }
    const updated = await tx.volunteerShift.update({ where: { id: shift.id }, data });
    await promoteLocked(tx, updated, staff.organisationId, now);
    return { ok: true, data: undefined };
  });
}

/** Closed shifts take no sign-ups, approvals or promotions; reopening promotes the waitlist. */
export async function setShiftClosed(staff: VolunteerStaff, shiftId: string, closed: boolean, now = new Date()): Promise<VolunteerResult> {
  if (!(await staffEvent(staff))) return fail("Event not found.");
  return prisma.$transaction(async (tx): Promise<VolunteerResult> => {
    const shift = await lockShift(tx, staff.eventId, shiftId);
    if (!shift) return fail(NOT_FOUND);
    const updated = await tx.volunteerShift.update({ where: { id: shift.id }, data: { closed } });
    if (!closed) await promoteLocked(tx, updated, staff.organisationId, now);
    return { ok: true, data: undefined };
  });
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
