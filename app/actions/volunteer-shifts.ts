"use server";

import { z } from "zod";
import type { ActionResult } from "./org";
import { createShift, deleteShift, setShiftClosed, setVolunteerShiftsEnabled, updateShift } from "@/lib/volunteer/shifts";
import { approveSignup, declineSignup, withdrawSignup } from "@/lib/volunteer/signups";
import { checkInToShift, checkOutOfShift, markNoShow } from "@/lib/volunteer/attendance";
import { adjustHours, verifyHours } from "@/lib/volunteer/hours";
import { issueContributorCertificate, revokeContributorCertificate, saveContributorCertificateTemplate } from "@/lib/volunteer/certificates";
import { audit, gate, id, revalidate, targetSchema } from "./volunteer-shifts/helpers";

/*
 * Guests → Crew → Shifts (docs/VOLUNTEERS.md): organiser actions for
 * volunteer shifts, sign-ups, the attendance desk, hours verification and
 * contributor certificates. Each needs the crew rule (MANAGE_REGISTRATIONS);
 * verification and certificates also owner/admin and a second person.
 */

type Result<T = undefined> = ActionResult<T>;
const done = <T>(result: { ok: true; data: T } | { ok: false; error: string }): Result<T> => (result.ok ? { ok: true, data: result.data } : result);

export async function setVolunteerShifts(input: unknown): Promise<Result> {
  const g = await gate(input, targetSchema.extend({ enabled: z.boolean() }));
  if (!g.ok) return g;
  const result = await setVolunteerShiftsEnabled(g.staff, g.data.enabled);
  if (result.ok) {
    await audit(g.event, g.data.enabled ? "VOLUNTEER_SHIFTS_ENABLED" : "VOLUNTEER_SHIFTS_DISABLED", "Event", g.event.eventId);
    revalidate(g.event);
  }
  return done(result);
}

/** Create (no `shiftId`) or edit a shift. `shift` is the shift form. */
export async function saveVolunteerShift(input: unknown): Promise<Result<{ id: string }>> {
  const g = await gate(input, targetSchema.extend({ shiftId: id.optional(), shift: z.unknown() }));
  if (!g.ok) return g;
  const result = g.data.shiftId
    ? await updateShift(g.staff, g.data.shiftId, g.data.shift).then((r) => (r.ok ? { ok: true as const, data: { id: g.data.shiftId! } } : r))
    : await createShift(g.staff, g.data.shift);
  if (result.ok) {
    await audit(g.event, g.data.shiftId ? "VOLUNTEER_SHIFT_UPDATED" : "VOLUNTEER_SHIFT_CREATED", "VolunteerShift", result.data.id);
    revalidate(g.event);
  }
  return done(result);
}

export async function closeVolunteerShift(input: unknown): Promise<Result> {
  const g = await gate(input, targetSchema.extend({ shiftId: id, closed: z.boolean() }));
  if (!g.ok) return g;
  const result = await setShiftClosed(g.staff, g.data.shiftId, g.data.closed);
  if (result.ok) await audit(g.event, g.data.closed ? "VOLUNTEER_SHIFT_CLOSED" : "VOLUNTEER_SHIFT_REOPENED", "VolunteerShift", g.data.shiftId);
  return done(result);
}

export async function deleteVolunteerShift(input: unknown): Promise<Result> {
  const g = await gate(input, targetSchema.extend({ shiftId: id }));
  if (!g.ok) return g;
  const result = await deleteShift(g.staff, g.data.shiftId);
  if (result.ok) {
    await audit(g.event, "VOLUNTEER_SHIFT_DELETED", "VolunteerShift", g.data.shiftId);
    revalidate(g.event);
  }
  return done(result);
}

/** Approve, decline or cancel (withdraw) one sign-up. */
export async function decideVolunteerSignup(input: unknown): Promise<Result<{ status?: string }>> {
  const g = await gate(input, targetSchema.extend({ signupId: id, decision: z.enum(["approve", "decline", "cancel"]) }));
  if (!g.ok) return g;
  const { signupId, decision } = g.data;
  const result = decision === "approve"
    ? await approveSignup(g.staff, signupId)
    : decision === "decline"
      ? await declineSignup(g.staff, signupId).then((r) => (r.ok ? { ok: true as const, data: {} } : r))
      : await withdrawSignup({ kind: "staff", staff: g.staff }, signupId).then((r) => (r.ok ? { ok: true as const, data: {} } : r));
  if (result.ok) await audit(g.event, decision === "approve" ? "VOLUNTEER_SIGNUP_APPROVED" : decision === "decline" ? "VOLUNTEER_SIGNUP_DECLINED" : "VOLUNTEER_SIGNUP_CANCELLED", "VolunteerShiftSignup", signupId);
  return done(result);
}

const deskTime = z.object({ occurredAt: z.string().max(40).optional(), reason: z.string().max(500).optional(), breakMinutes: z.number().int().min(0).max(720).optional() }).strict();

/** The attendance desk: check a volunteer in or out (optionally at an earlier time, with a reason), or mark a no-show. */
export async function recordVolunteerAttendance(input: unknown): Promise<Result<{ minutes?: number }>> {
  const g = await gate(input, targetSchema.extend({ signupId: id, action: z.enum(["check-in", "check-out", "no-show"]), desk: deskTime.optional() }));
  if (!g.ok) return g;
  const actor = { kind: "desk" as const, staff: g.staff };
  const { signupId, action, desk } = g.data;
  const result = action === "check-in"
    ? await checkInToShift(actor, signupId, desk).then((r) => (r.ok ? { ok: true as const, data: {} } : r))
    : action === "check-out"
      ? await checkOutOfShift(actor, signupId, desk)
      : await markNoShow(g.staff, signupId).then((r) => (r.ok ? { ok: true as const, data: {} } : r));
  if (result.ok) await audit(g.event, action === "no-show" ? "VOLUNTEER_NO_SHOW" : action === "check-in" ? "VOLUNTEER_CHECKED_IN" : "VOLUNTEER_CHECKED_OUT", "VolunteerShiftSignup", signupId);
  return done(result);
}

/** Verify pending hours, or adjust verified ones with a reason. Owner/admin, never the volunteer. */
export async function reviewVolunteerHours(input: unknown): Promise<Result<{ minutes: number; revokedCertificate: boolean }>> {
  const g = await gate(input, targetSchema.extend({ hoursId: id, action: z.enum(["verify", "adjust"]), minutes: z.number().optional(), reason: z.string().max(500).optional() }));
  if (!g.ok) return g;
  const result = g.data.action === "verify" ? await verifyHours(g.staff, g.data.hoursId) : await adjustHours(g.staff, g.data.hoursId, g.data.minutes, g.data.reason);
  if (result.ok) await audit(g.event, g.data.action === "verify" ? "VOLUNTEER_HOURS_VERIFIED" : "VOLUNTEER_HOURS_ADJUSTED", "VolunteerHours", g.data.hoursId);
  return done(result);
}

/** Issue or revoke a crew member's contributor certificate. Owner/admin, never for themself. */
export async function manageContributorCertificate(input: unknown): Promise<Result> {
  const g = await gate(input, targetSchema.extend({ crewMemberId: id, action: z.enum(["issue", "revoke"]) }));
  if (!g.ok) return g;
  const result = g.data.action === "issue"
    ? await issueContributorCertificate(g.staff, g.data.crewMemberId).then((r) => (r.ok ? { ok: true as const, data: undefined } : r))
    : await revokeContributorCertificate(g.staff, g.data.crewMemberId);
  if (result.ok) await audit(g.event, g.data.action === "issue" ? "CONTRIBUTOR_CERTIFICATE_ISSUED" : "CONTRIBUTOR_CERTIFICATE_REVOKED", "EventCrewMember", g.data.crewMemberId);
  return done(result);
}

/** Save or clear the contributor certificate design (owner/admin). */
export async function saveContributorCertificateDesign(input: unknown): Promise<Result> {
  const g = await gate(input, targetSchema.extend({ template: z.unknown() }));
  if (!g.ok) return g;
  const result = await saveContributorCertificateTemplate(g.staff, g.data.template);
  if (result.ok) await audit(g.event, "CONTRIBUTOR_CERTIFICATE_DESIGN_SAVED", "Event", g.event.eventId);
  return done(result);
}
