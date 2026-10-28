import { z } from "zod";
import { iso, url } from "./core";

/*
 * Volunteer shifts (docs/VOLUNTEERS.md) for the mobile app: a crew member's
 * own shifts, and the organiser roster. No emails, tokens or adjustment
 * reasons; the only capability is the caller's own certificate link.
 */

const signupStatus = z.enum(["APPLIED", "WAITLISTED", "APPROVED", "WITHDRAWN", "DECLINED"]);
const attendance = z.enum(["SCHEDULED", "CHECKED_IN", "CHECKED_OUT", "NO_SHOW"]);
const hoursState = z.enum(["PENDING", "VERIFIED", "ADJUSTED"]);
const crewKind = z.enum(["ORGANISER", "VOLUNTEER", "MENTOR", "JUDGE"]);

const shiftBase = {
  id: z.string(), title: z.string(), zone: z.string(), task: z.string(),
  startsAt: iso, endsAt: iso, signupDeadline: iso, graceMinutes: z.number().int(), requiresApproval: z.boolean(),
};

export const myShiftSchema = z.object({
  ...shiftBase,
  open: z.boolean(),
  placesLeft: z.number().int().nullable(),
  checkInOpen: z.boolean(),
  signup: z.object({
    id: z.string(), status: signupStatus, attendance, checkedInAt: iso.nullable(), checkedOutAt: iso.nullable(),
    minutes: z.number().int().nullable(), hoursState: hoursState.nullable(),
  }).strict().nullable(),
}).strict();

/** A crew member's own shifts. `certificateUrl` is their own contributor certificate download (a capability), or null. */
export const myShiftsDtoSchema = z.object({
  timeZone: z.string(),
  verifiedMinutes: z.number().int(),
  certificateUrl: url.nullable(),
  shifts: z.array(myShiftSchema),
}).strict();

export const rosterSignupSchema = z.object({
  id: z.string(), crewMemberId: z.string(), name: z.string(), kind: crewKind, status: signupStatus, attendance, queuedAt: iso,
  checkedInAt: iso.nullable(), checkedOutAt: iso.nullable(), breakMinutes: z.number().int(),
  hours: z.object({ id: z.string(), minutes: z.number().int(), state: hoursState }).strict().nullable(),
  /** The signed-in organiser's own sign-up: they cannot verify these hours. */
  isViewer: z.boolean(),
}).strict();

export const rosterShiftSchema = z.object({
  ...shiftBase,
  capacity: z.number().int(), waitlistEnabled: z.boolean(), closed: z.boolean(), approved: z.number().int(),
  signups: z.array(rosterSignupSchema),
}).strict();

export const contributorSchema = z.object({
  crewMemberId: z.string(), name: z.string(), kind: crewKind, role: z.string(), verifiedMinutes: z.number().int(), pendingHours: z.number().int(),
  certificate: z.object({ issuedAt: iso }).strict().nullable(), eligible: z.boolean(), isViewer: z.boolean(),
  claims: z.object({ open: z.number().int(), total: z.number().int() }).strict(),
}).strict();

/** Guests → Crew → Shifts for the organiser (MANAGE_REGISTRATIONS; `isAdmin` may verify hours). */
export const volunteerRosterDtoSchema = z.object({
  enabled: z.boolean(),
  isAdmin: z.boolean(),
  timeZone: z.string(),
  shifts: z.array(rosterShiftSchema),
  contributors: z.array(contributorSchema),
}).strict();
