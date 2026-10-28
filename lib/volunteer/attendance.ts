import "server-only";

import { prisma } from "@/lib/db";
import { canCheckInAt, countedMinutes, withinDutyWindow } from "./math";
import { SIGNUP_NOT_FOUND, fail, lockCrewMember, reasonSchema, type VolunteerResult, type VolunteerSelf, type VolunteerStaff } from "./shared";

/*
 * Shift attendance (docs/VOLUNTEERS.md), after the Space Works attendance
 * workflow. It never touches the event check-in. Volunteers check themselves
 * in and out at the current time, inside the shift's grace window; the desk
 * (organisers with the crew rule) may enter an earlier time with a reason,
 * which is kept in an append-only correction. One active duty per person,
 * counted intervals never overlap, and minutes are elapsed time less breaks.
 */

export type AttendanceActor = { kind: "self"; self: VolunteerSelf } | { kind: "desk"; staff: VolunteerStaff };
export type DeskTime = { occurredAt?: string; reason?: string; breakMinutes?: number };

function resolveTime(actor: AttendanceActor, desk: DeskTime | undefined, now: Date): { at: Date; reason: string | null } | { error: string } {
  if (actor.kind === "self" || !desk?.occurredAt) return { at: now, reason: null };
  const at = new Date(desk.occurredAt);
  if (Number.isNaN(at.getTime()) || at > now) return { error: "Choose a time that isn't in the future." };
  const reason = reasonSchema.safeParse(desk.reason ?? "");
  if (!reason.success) return { error: "Explain why you're entering a different time." };
  return { at, reason: reason.data };
}

/** Check in to an approved shift: inside the window, and not while on another duty. */
export async function checkInToShift(actor: AttendanceActor, signupId: string, desk?: DeskTime, now = new Date()): Promise<VolunteerResult> {
  const time = resolveTime(actor, desk, now);
  if ("error" in time) return fail(time.error);
  const eventId = actor.kind === "self" ? actor.self.eventId : actor.staff.eventId;
  return prisma.$transaction(async (tx): Promise<VolunteerResult> => {
    const row = await tx.volunteerShiftSignup.findFirst({ where: scopeWhere(actor, signupId), select: { crewMemberId: true } });
    if (!row) return fail(SIGNUP_NOT_FOUND);
    if (!(await lockCrewMember(tx, eventId, row.crewMemberId))) return fail(SIGNUP_NOT_FOUND);
    const signup = await tx.volunteerShiftSignup.findUniqueOrThrow({ where: { id: signupId }, include: { shift: true } });
    if (signup.status !== "APPROVED") return fail("Only approved volunteers can check in.");
    if (signup.attendance !== "SCHEDULED") return fail(signup.attendance === "NO_SHOW" ? "This volunteer was marked as a no-show." : "Already checked in to this shift.");
    if (!canCheckInAt(signup.shift, time.at)) return fail(`Check-in opens ${signup.shift.graceMinutes} minutes before the shift and closes when it ends.`);
    const active = await tx.volunteerShiftSignup.count({ where: { crewMemberId: row.crewMemberId, attendance: "CHECKED_IN", id: { not: signupId } } });
    if (active > 0) return fail("Check out of the other shift first.");
    await tx.volunteerShiftSignup.update({ where: { id: signupId }, data: { attendance: "CHECKED_IN", checkedInAt: time.at, attendanceSource: actor.kind, attendanceActorId: actor.kind === "desk" ? actor.staff.userId : null } });
    if (time.reason) await tx.volunteerAttendanceCorrection.create({ data: { eventId, signupId, actorUserId: actor.kind === "desk" ? actor.staff.userId : null, action: "check-in", occurredAt: time.at, reason: time.reason } });
    return { ok: true, data: undefined };
  });
}

/**
 * Check out and record pending hours. Volunteers check out themselves until
 * the grace period after the end; later, the desk enters the time. Only the
 * desk records breaks.
 */
export async function checkOutOfShift(actor: AttendanceActor, signupId: string, desk?: DeskTime, now = new Date()): Promise<VolunteerResult<{ minutes: number }>> {
  const time = resolveTime(actor, desk, now);
  if ("error" in time) return fail(time.error);
  const eventId = actor.kind === "self" ? actor.self.eventId : actor.staff.eventId;
  return prisma.$transaction(async (tx): Promise<VolunteerResult<{ minutes: number }>> => {
    const row = await tx.volunteerShiftSignup.findFirst({ where: scopeWhere(actor, signupId), select: { crewMemberId: true } });
    if (!row) return fail(SIGNUP_NOT_FOUND);
    if (!(await lockCrewMember(tx, eventId, row.crewMemberId))) return fail(SIGNUP_NOT_FOUND);
    const signup = await tx.volunteerShiftSignup.findUniqueOrThrow({ where: { id: signupId }, include: { shift: true } });
    if (signup.attendance !== "CHECKED_IN" || !signup.checkedInAt) return fail("This volunteer isn't checked in to this shift.");
    if (!withinDutyWindow(signup.shift, time.at)) return fail(actor.kind === "self" ? "Check-out has closed for this shift. Ask the desk to record your time." : "Choose a time within the shift and its grace period.");
    const breaks = actor.kind === "desk" && desk?.breakMinutes !== undefined ? desk.breakMinutes : signup.breakMinutes;
    const minutes = countedMinutes(signup.checkedInAt, time.at, breaks);
    if (minutes == null) return fail(time.at < signup.checkedInAt ? "Check-out must be after check-in." : "Breaks can't be longer than the time on duty.");
    const overlap = await tx.volunteerShiftSignup.count({
      where: { crewMemberId: row.crewMemberId, id: { not: signupId }, attendance: "CHECKED_OUT", checkedInAt: { lt: time.at }, checkedOutAt: { gt: signup.checkedInAt } },
    });
    if (overlap > 0) return fail("This time overlaps hours already recorded for another shift.");
    await tx.volunteerShiftSignup.update({ where: { id: signupId }, data: { attendance: "CHECKED_OUT", checkedOutAt: time.at, breakMinutes: breaks, attendanceActorId: actor.kind === "desk" ? actor.staff.userId : signup.attendanceActorId } });
    await tx.volunteerHours.create({ data: { eventId, signupId, minutes } });
    if (time.reason) await tx.volunteerAttendanceCorrection.create({ data: { eventId, signupId, actorUserId: actor.kind === "desk" ? actor.staff.userId : null, action: "check-out", occurredAt: time.at, reason: time.reason } });
    return { ok: true, data: { minutes } };
  });
}

/** After the shift ends, the desk marks an approved volunteer who never checked in. */
export async function markNoShow(staff: VolunteerStaff, signupId: string, now = new Date()): Promise<VolunteerResult> {
  return prisma.$transaction(async (tx): Promise<VolunteerResult> => {
    const signup = await tx.volunteerShiftSignup.findFirst({ where: scopeWhere({ kind: "desk", staff }, signupId), include: { shift: true } });
    if (!signup) return fail(SIGNUP_NOT_FOUND);
    if (now < signup.shift.endsAt) return fail("The shift hasn't ended yet.");
    const updated = await tx.volunteerShiftSignup.updateMany({ where: { id: signup.id, status: "APPROVED", attendance: "SCHEDULED" }, data: { attendance: "NO_SHOW", attendanceSource: "desk", attendanceActorId: staff.userId } });
    return updated.count === 1 ? { ok: true, data: undefined } : fail("Only approved volunteers who never checked in can be marked as a no-show.");
  });
}

function scopeWhere(actor: AttendanceActor, signupId: string) {
  return actor.kind === "self"
    ? { id: signupId, eventId: actor.self.eventId, crewMemberId: actor.self.crewMemberId }
    : { id: signupId, eventId: actor.staff.eventId, shift: { event: { organisationId: actor.staff.organisationId } } };
}
