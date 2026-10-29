import "server-only";

import type { Prisma, VolunteerShift } from "@prisma/client";
import { prisma } from "@/lib/db";
import { enqueueVolunteerNotice } from "@/lib/outbox/volunteer";
import { lockCrewPersons, requirePersonsLocked, retryWhenPersonsChange } from "@/lib/personLock";
import { placesLeft } from "./math";
import {
  BOOKED_OFFICE_HOUR,
  NOT_FOUND,
  PEOPLE_CHANGED,
  SHIFTS_OFF,
  SIGNUP_NOT_FOUND,
  approvedCount,
  crewTicketLive,
  fail,
  hasBookedOfficeHourBetween,
  hasOverlappingDuty,
  lockCrewMember,
  lockCrewMembers,
  lockShift,
  type VolunteerResult,
  type VolunteerSelf,
  type VolunteerStaff,
} from "./shared";

/*
 * Shift sign-ups (docs/VOLUNTEERS.md), after the Space Works shift workflow:
 * APPLIED → APPROVED (or WAITLISTED when full) → WITHDRAWN, or DECLINED by an
 * organiser. Places are counted under the shift row lock; a person never
 * holds two overlapping approved shifts (checked under their crew row lock),
 * nor an approved shift overlapping one of their booked office hours as a
 * mentor (checked under their person lock); the waitlist is promoted first
 * in, first out, skipping people who now overlap. Kind never matters: any
 * crew member may sign up. Lock order (docs/VOLUNTEERS.md "Locks"): the
 * person locks of everyone a command may approve (lib/personLock.ts), the
 * shift, then their crew rows in one id-ordered batch.
 */

type Approval = { status: "APPROVED" | "WAITLISTED" } | { ok: false; error: string };

/** Approve under the shift and member locks, or waitlist when full. */
async function approveLocked(tx: Prisma.TransactionClient, shift: VolunteerShift, signupId: string, crewMemberId: string, approverId: string | null): Promise<Approval> {
  if (await hasOverlappingDuty(tx, crewMemberId, shift)) return fail("This volunteer already has a place on a shift at the same time.");
  if (await hasBookedOfficeHourBetween(tx, shift.eventId, crewMemberId, shift)) return fail(BOOKED_OFFICE_HOUR);
  if (placesLeft(shift.capacity, await approvedCount(tx, shift.id)) === 0) {
    if (!shift.waitlistEnabled) return fail("This shift is full.");
    await tx.volunteerShiftSignup.update({ where: { id: signupId }, data: { status: "WAITLISTED" } });
    return { status: "WAITLISTED" };
  }
  await tx.volunteerShiftSignup.update({ where: { id: signupId }, data: { status: "APPROVED", approvedAt: new Date(), approvedByUserId: approverId } });
  return { status: "APPROVED" };
}

const isOpen = (shift: VolunteerShift, now: Date) => !shift.closed && now < shift.startsAt;

/**
 * A crew member signs up from their crew ticket. Without approval they get a
 * place at once (or join the waitlist when full); otherwise they wait for an
 * organiser. Someone who withdrew may sign up again; a declined sign-up stays declined.
 */
export async function applyForShift(self: VolunteerSelf, shiftId: string, now = new Date()): Promise<VolunteerResult<{ status: string }>> {
  return retryWhenPersonsChange(() => prisma.$transaction(async (tx): Promise<VolunteerResult<{ status: string }>> => {
    const event = await tx.event.findUnique({ where: { id: self.eventId }, select: { volunteerShiftsEnabled: true, status: true, organisationId: true } });
    if (!event?.volunteerShiftsEnabled || event.status === "CANCELLED") return fail(SHIFTS_OFF);
    // An automatic approval is checked against the person's office hours: their person lock first.
    const people = await lockCrewPersons(tx, self.eventId, [self.crewMemberId]);
    const shift = await lockShift(tx, self.eventId, shiftId);
    if (!shift) return fail(NOT_FOUND);
    if (!isOpen(shift, now) || now >= shift.signupDeadline) return fail("Sign-ups for this shift are closed.");
    const member = await lockCrewMember(tx, self.eventId, self.crewMemberId);
    if (!member || !crewTicketLive(member)) return fail("Your crew ticket is no longer valid.");
    await requirePersonsLocked(tx, self.eventId, [member.id], people);
    const existing = await tx.volunteerShiftSignup.findUnique({ where: { shiftId_crewMemberId: { shiftId: shift.id, crewMemberId: member.id } }, select: { id: true, status: true } });
    if (existing && existing.status !== "WITHDRAWN") return fail(existing.status === "DECLINED" ? "The organisers declined your sign-up for this shift." : "You've already signed up for this shift.");
    const signup = existing
      ? await tx.volunteerShiftSignup.update({ where: { id: existing.id }, data: { status: "APPLIED", queuedAt: now, approvedAt: null, approvedByUserId: null }, select: { id: true } })
      : await tx.volunteerShiftSignup.create({ data: { eventId: self.eventId, shiftId: shift.id, crewMemberId: member.id, queuedAt: now }, select: { id: true } });
    if (shift.requiresApproval) return { ok: true, data: { status: "APPLIED" } };
    const outcome = await approveLocked(tx, shift, signup.id, member.id, null);
    if ("ok" in outcome) throw new SignupRefused(outcome.error);
    if (outcome.status === "APPROVED") await enqueueVolunteerNotice(tx, { to: member.email, organisationId: event.organisationId, notice: "approved", crewMemberId: member.id, signupId: signup.id });
    return { ok: true, data: outcome };
  }).catch(refusal), fail(PEOPLE_CHANGED));
}

/** Thrown inside a transaction to roll back a sign-up that was refused after it was written. */
class SignupRefused extends Error {}
function refusal(error: unknown): VolunteerResult<never> {
  if (error instanceof SignupRefused) return fail(error.message);
  throw error;
}

/** Locks the sign-up's shift and crew row; when `approving`, the person lock before them. */
async function staffSignup(tx: Prisma.TransactionClient, staff: VolunteerStaff, signupId: string, approving = false) {
  const row = await tx.volunteerShiftSignup.findFirst({ where: { id: signupId, eventId: staff.eventId, shift: { event: { organisationId: staff.organisationId } } }, select: { id: true, shiftId: true, crewMemberId: true } });
  if (!row) return null;
  const people = approving ? await lockCrewPersons(tx, staff.eventId, [row.crewMemberId]) : null;
  const shift = await lockShift(tx, staff.eventId, row.shiftId);
  const member = await lockCrewMember(tx, staff.eventId, row.crewMemberId);
  if (people && member) await requirePersonsLocked(tx, staff.eventId, [member.id], people);
  const signup = await tx.volunteerShiftSignup.findUnique({ where: { id: row.id } });
  return shift && member && signup ? { shift, member, signup } : null;
}

export async function approveSignup(staff: VolunteerStaff, signupId: string, now = new Date()): Promise<VolunteerResult<{ status: string }>> {
  return retryWhenPersonsChange(() => prisma.$transaction(async (tx): Promise<VolunteerResult<{ status: string }>> => {
    const found = await staffSignup(tx, staff, signupId, true);
    if (!found) return fail(SIGNUP_NOT_FOUND);
    const { shift, member, signup } = found;
    if (signup.status !== "APPLIED" && signup.status !== "WAITLISTED") return fail("Only sign-ups that are waiting can be approved.");
    if (!isOpen(shift, now)) return fail("This shift has started or is closed.");
    if (!crewTicketLive(member)) return fail("This crew ticket is no longer valid.");
    const outcome = await approveLocked(tx, shift, signup.id, member.id, staff.userId);
    if ("ok" in outcome) return outcome;
    if (outcome.status === "APPROVED") await enqueueVolunteerNotice(tx, { to: member.email, organisationId: staff.organisationId, notice: "approved", crewMemberId: member.id, signupId: signup.id });
    return { ok: true, data: outcome };
  }), fail(PEOPLE_CHANGED));
}

export async function declineSignup(staff: VolunteerStaff, signupId: string): Promise<VolunteerResult> {
  return prisma.$transaction(async (tx): Promise<VolunteerResult> => {
    const found = await staffSignup(tx, staff, signupId);
    if (!found) return fail(SIGNUP_NOT_FOUND);
    if (found.signup.status !== "APPLIED" && found.signup.status !== "WAITLISTED") return fail("Only sign-ups that are waiting can be declined.");
    await tx.volunteerShiftSignup.update({ where: { id: found.signup.id }, data: { status: "DECLINED" } });
    return { ok: true, data: undefined };
  });
}

type Withdrawer = { kind: "self"; self: VolunteerSelf } | { kind: "staff"; staff: VolunteerStaff };

/**
 * Withdraws a sign-up before work starts: the volunteer from their ticket, or
 * an organiser (who cancels their place and tells them). A freed place goes
 * to the waitlist first in, first out.
 */
export async function withdrawSignup(by: Withdrawer, signupId: string, now = new Date()): Promise<VolunteerResult> {
  return retryWhenPersonsChange(() => prisma.$transaction(async (tx): Promise<VolunteerResult> => {
    const eventId = by.kind === "self" ? by.self.eventId : by.staff.eventId;
    const row = await tx.volunteerShiftSignup.findFirst({
      where: { id: signupId, eventId, ...(by.kind === "self" ? { crewMemberId: by.self.crewMemberId } : { shift: { event: { organisationId: by.staff.organisationId } } }) },
      select: { shiftId: true, crewMemberId: true },
    });
    if (!row) return fail(SIGNUP_NOT_FOUND);
    // Everyone a freed place may go to: their person locks, the shift, then (with the withdrawer) their crew rows in one id-ordered lock.
    const people = await lockCrewPersons(tx, eventId, await waitlistedMemberIds(tx, row.shiftId));
    const shift = await lockShift(tx, eventId, row.shiftId);
    const waiting = await waitlistedMemberIds(tx, row.shiftId);
    await lockCrewMembers(tx, eventId, [row.crewMemberId, ...waiting]);
    await requirePersonsLocked(tx, eventId, waiting, people);
    const member = await lockCrewMember(tx, eventId, row.crewMemberId);
    const signup = await tx.volunteerShiftSignup.findUnique({ where: { id: signupId } });
    if (!shift || !member || !signup) return fail(SIGNUP_NOT_FOUND);
    if (!["APPLIED", "WAITLISTED", "APPROVED"].includes(signup.status)) return fail("This sign-up is already closed.");
    if (signup.attendance !== "SCHEDULED") return fail("Work has started on this shift. Ask an organiser to close it.");
    await tx.volunteerShiftSignup.update({ where: { id: signup.id }, data: { status: "WITHDRAWN", approvedAt: null, approvedByUserId: null } });
    const event = await tx.event.findUniqueOrThrow({ where: { id: eventId }, select: { organisationId: true } });
    if (by.kind === "staff" && signup.status !== "APPLIED") {
      const snapshot = { title: shift.title, zone: shift.zone, startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString() };
      await enqueueVolunteerNotice(tx, { to: member.email, organisationId: event.organisationId, notice: "cancelled", crewMemberId: member.id, shift: snapshot });
    }
    if (signup.status === "APPROVED") await promoteLocked(tx, shift, event.organisationId, now);
    return { ok: true, data: undefined };
  }), fail(PEOPLE_CHANGED));
}

/** The crew members waiting on a shift (the people a freed place or more room may go to). */
async function waitlistedMemberIds(tx: Prisma.TransactionClient, shiftId: string) {
  const rows = await tx.volunteerShiftSignup.findMany({ where: { shiftId, status: "WAITLISTED" }, select: { crewMemberId: true } });
  return rows.map((row) => row.crewMemberId);
}

/**
 * First in, first out: while places are left, approve waitlisted sign-ups by
 * `queuedAt`, skipping anyone whose crew ticket no longer works, who now has
 * an overlapping approved shift or a booked office hour at the time. Only
 * before the shift starts and while it is open. Callers hold the waitlist's
 * person locks, the shift lock, and the waitlist's crew rows (one batch), so
 * the crew lock below takes nothing new.
 */
export async function promoteLocked(tx: Prisma.TransactionClient, shift: VolunteerShift, organisationId: string, now: Date) {
  if (!isOpen(shift, now)) return 0;
  const waiting = await tx.volunteerShiftSignup.findMany({ where: { shiftId: shift.id, status: "WAITLISTED" }, orderBy: [{ queuedAt: "asc" }, { id: "asc" }], select: { id: true, crewMemberId: true } });
  // Everyone who may be promoted, locked up front in id order (never one by one in queue order).
  await lockCrewMembers(tx, shift.eventId, waiting.map((row) => row.crewMemberId));
  let promoted = 0;
  for (const row of waiting) {
    if (placesLeft(shift.capacity, await approvedCount(tx, shift.id)) === 0) break;
    const member = await lockCrewMember(tx, shift.eventId, row.crewMemberId);
    if (!member || !crewTicketLive(member) || (await hasOverlappingDuty(tx, member.id, shift)) || (await hasBookedOfficeHourBetween(tx, shift.eventId, member.id, shift))) continue;
    await tx.volunteerShiftSignup.update({ where: { id: row.id }, data: { status: "APPROVED", approvedAt: now, approvedByUserId: null } });
    await enqueueVolunteerNotice(tx, { to: member.email, organisationId, notice: "promoted", crewMemberId: member.id, signupId: row.id });
    promoted += 1;
  }
  return promoted;
}
