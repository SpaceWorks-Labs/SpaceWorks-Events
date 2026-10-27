import type { Prisma } from "@prisma/client";
import { ATTENDANCE_STATE_LABELS, attendanceBadgeLabel, attendanceStateOf, asReleaseOutcome, type AttendanceResponseValue, type AttendanceState } from "@/lib/attendanceCheck";
import { attendanceEligibleRsvpWhere } from "@/lib/attendanceEligibility";

/*
 * Attendance confirmation in Guests · People and the attendee CSV
 * (docs/ATTENDANCE.md). Pure; one-off events only.
 */

/**
 * The attendance reply filter. `noReply` and `notAsked` cover eligible
 * (going) guests only, matching the Emails card's counts; `coming` and
 * `notComing` keep a reply even if the registration changed since.
 */
export const ATTENDEE_ATTENDANCE_FILTERS = ["all", "coming", "notComing", "noReply", "notAsked"] as const;
export type AttendeeAttendanceFilter = (typeof ATTENDEE_ATTENDANCE_FILTERS)[number];

/** One attendance reply filter as a condition ("all" adds nothing). */
export function attendeeAttendanceWhere(attendance: AttendeeAttendanceFilter): Prisma.RSVPWhereInput {
  switch (attendance) {
    case "all":
      return {};
    case "coming":
      return { attendanceCheck: { is: { response: "ATTENDING" } } };
    case "notComing":
      return { attendanceCheck: { is: { response: "NOT_ATTENDING" } } };
    case "noReply":
      return { AND: [attendanceEligibleRsvpWhere(), { attendanceCheck: { is: { response: null } } }] };
    case "notAsked":
      return { AND: [attendanceEligibleRsvpWhere(), { attendanceCheck: { is: null } }] };
  }
}

type BadgeInput = { status: string; attendanceCheck: { response: AttendanceResponseValue | null; releaseOutcome?: string | null; } | null | undefined; };

/**
 * The attendance badge for one registration, or null when there is nothing
 * to say: a guest who was never asked shows "Not asked" only while going
 * (CONFIRMED), and only when `showNotAsked` (someone at the event has been
 * asked; before the first send every going guest would carry it).
 */
export function attendanceBadgeState(rsvp: BadgeInput, options: { showNotAsked?: boolean; } = {}): AttendanceState | null {
  if (rsvp.attendanceCheck) return attendanceStateOf(rsvp.attendanceCheck);
  return rsvp.status === "CONFIRMED" && options.showNotAsked !== false ? "notAsked" : null;
}

/**
 * The attendee CSV's "Attendance confirmation" and "Attendance note" cells,
 * with the same "Not asked" rule as the badge ("Said No · paid" for a paid
 * place kept after a No). Raw text: lib/csv.ts neutralises formulas when the
 * row is written.
 */
export function attendanceCsvCells(rsvp: BadgeInput & { attendanceCheck: { note: string | null; } | null | undefined; }, options: { showNotAsked?: boolean; } = {}): [string, string] {
  const state = attendanceBadgeState(rsvp, options);
  const label = state ? attendanceBadgeLabel(state, asReleaseOutcome(rsvp.attendanceCheck?.releaseOutcome)) : "";
  return [label, rsvp.attendanceCheck?.note ?? ""];
}

export { ATTENDANCE_STATE_LABELS };
