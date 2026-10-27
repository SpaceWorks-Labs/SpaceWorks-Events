/*
 * Attendance confirmation ("Are you still coming?", docs/ATTENDANCE.md): pure
 * rules shared by the server core (lib/core/attendanceCheck/*), the
 * dashboard, the check-in desk and the unit tests. No I/O.
 *
 * Nothing is ever sent automatically. An organisation owner or admin sends
 * the question from the Emails tab (or shares one guest's link), and only the
 * registrations matching `attendanceEligibleRsvpWhere` (lib/attendanceEligibility.ts)
 * are asked.
 */

/** Longest optional note a guest can leave with their answer (a CHECK enforces it too). */
export const ATTENDANCE_NOTE_MAX = 500;

/** "Remind people who haven't replied" reaches one guest at most once per this interval. */
export const ATTENDANCE_REMINDER_INTERVAL_MS = 12 * 60 * 60_000;

export type AttendanceResponseValue = "ATTENDING" | "NOT_ATTENDING";

/** Per-guest state shown as a badge in Guests · People and at the check-in desk. */
export type AttendanceState = "coming" | "notComing" | "noReply" | "notAsked";

export const ATTENDANCE_STATES: readonly AttendanceState[] = ["coming", "notComing", "noReply", "notAsked"];

export const ATTENDANCE_STATE_LABELS: Record<AttendanceState, string> = {
  coming: "Coming",
  notComing: "Not coming",
  noReply: "No reply",
  notAsked: "Not asked",
};

/**
 * What happened to a "No" whose place was not released automatically
 * (`AttendanceCheck.releaseOutcome`, a CHECK keeps these values):
 * - `multiTicket`: a paid order holding several places; organisers were told.
 * - `notBuyer`: someone else paid for the ticket; organisers were told.
 * - `refundRequested`: the refund policy no longer allows a cancellation, so a
 *   refund request was opened and the place is kept until organisers decide.
 * - `failed`: the release was refused (for example, already checked in).
 */
export type AttendanceReleaseOutcome = "multiTicket" | "notBuyer" | "refundRequested" | "failed";

export const ATTENDANCE_RELEASE_OUTCOMES: readonly AttendanceReleaseOutcome[] = ["multiTicket", "notBuyer", "refundRequested", "failed"];

export function asReleaseOutcome(value: string | null | undefined): AttendanceReleaseOutcome | null {
  return ATTENDANCE_RELEASE_OUTCOMES.includes(value as AttendanceReleaseOutcome) ? (value as AttendanceReleaseOutcome) : null;
}

/** The organiser-facing line under a "No" that kept its place. */
export const ATTENDANCE_RELEASE_OUTCOME_LABELS: Record<AttendanceReleaseOutcome, string> = {
  multiTicket: "Paid order with several tickets, so nothing was cancelled. Cancel or refund it from the order if needed.",
  notBuyer: "Someone else paid for this ticket, so nothing was cancelled. Cancel or refund it from the order if needed.",
  refundRequested: "The refund window has closed, so the place is kept and a refund request was opened in Finance.",
  failed: "The place could not be released automatically, so it is kept.",
};

/**
 * The badge text: a "No" on a paid ticket that kept its place reads
 * "Said No · paid", so organisers see it still holds a seat.
 */
export function attendanceBadgeLabel(state: AttendanceState, outcome: AttendanceReleaseOutcome | null | undefined): string {
  if (state === "notComing" && outcome && outcome !== "failed") return "Said No · paid";
  return ATTENDANCE_STATE_LABELS[state];
}

/** The guest's state from their check (null when they were never asked). */
export function attendanceStateOf(check: { response: AttendanceResponseValue | null } | null | undefined): AttendanceState {
  if (!check) return "notAsked";
  if (check.response === "ATTENDING") return "coming";
  if (check.response === "NOT_ATTENDING") return "notComing";
  return "noReply";
}

/** The question can be sent (and answered) only before the event starts. */
export function attendanceCheckOpen(eventStart: Date, now: Date = new Date()): boolean {
  return now.getTime() < eventStart.getTime();
}

/** A guest who has not replied can be reminded once the last email is at least 12 hours old. */
export function isReminderDue(sentAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - sentAt.getTime() >= ATTENDANCE_REMINDER_INTERVAL_MS;
}

export type AttendanceReplyClosed = "cancelled" | "started" | "notConfirmed";

/**
 * Why the reply form is closed, or null while the guest can still answer or
 * change their answer. `eligible` is whether the registration still matches
 * `attendanceEligibleRsvpWhere` (CONFIRMED, one-off event).
 */
export function attendanceReplyClosedReason(input: { eligible: boolean; eventStart: Date; eventStatus?: string; now?: Date }): AttendanceReplyClosed | null {
  if (input.eventStatus === "CANCELLED") return "cancelled";
  if (!attendanceCheckOpen(input.eventStart, input.now ?? new Date())) return "started";
  if (!input.eligible) return "notConfirmed";
  return null;
}

/** Parses the email's `?answer=` preselect; anything else selects nothing. */
export function parseAnswerPreselect(value: unknown): AttendanceResponseValue | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === "yes") return "ATTENDING";
  if (raw === "no") return "NOT_ATTENDING";
  return null;
}

/**
 * What a "No" would do to this registration right now, with release on:
 * `free` cancels the registration, `paid` cancels the buyer's order under its
 * refund policy, null keeps the place (release off, or a paid ticket that
 * can't be released automatically). Only a non-null value lets the email and
 * the form say "No releases your place".
 */
export type AttendanceReleaseKind = "free" | "paid";

export type AttendanceSummary = {
  /** Guests asked so far (rows that still exist). */
  asked: number;
  coming: number;
  notComing: number;
  noReply: number;
  /** Eligible guests who have never been asked (for example confirmed after the first send). */
  notAsked: number;
  /** Not-replied guests whose last email is at least 12 hours old. */
  remindable: number;
  /** Places released because a guest answered "No" while release was on. */
  released: number;
};

/** "Attendance: 12 coming · 3 not coming · 5 no reply": the Overview readiness line. */
export function describeAttendanceReplies(summary: Pick<AttendanceSummary, "coming" | "notComing" | "noReply">): string {
  return `Attendance: ${summary.coming} coming · ${summary.notComing} not coming · ${summary.noReply} no reply`;
}

/** Card copy for how many emails a send would queue. */
export function attendanceSendLabel(count: number, firstSend: boolean): string {
  if (count === 0) return firstSend ? "No confirmed guests to ask" : "Everyone confirmed has been asked";
  const people = `${count} ${count === 1 ? "guest" : "guests"}`;
  return firstSend ? `Ask ${people} to confirm` : `Ask ${people} newly confirmed`;
}

/** The check-in desk's badge: only for guests who were asked (the note stays in Guests · People). */
export function deskAttendanceState(check: { response: AttendanceResponseValue | null } | null | undefined): AttendanceState | null {
  return check ? attendanceStateOf(check) : null;
}
