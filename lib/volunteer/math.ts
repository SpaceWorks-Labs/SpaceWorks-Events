/*
 * Pure shift and hours arithmetic (docs/VOLUNTEERS.md), after the Space Works
 * attendance workflow: counted minutes are the whole minutes between check-in
 * and check-out less breaks, check-in is open from the grace period before
 * the start until the end, and check-out closes the grace period after it.
 */

export const MAX_GRACE_MINUTES = 60;
export const MAX_SHIFT_MINUTES = 12 * 60;
/** The largest single verified or adjusted entry, as in the source design. */
export const MAX_ENTRY_MINUTES = 1440;

const MINUTE = 60_000;

export type Interval = { start: Date; end: Date };
export type ShiftWindow = { startsAt: Date; endsAt: Date; graceMinutes: number };

/**
 * Whole minutes worked between check-in and check-out, less breaks. Null for
 * an invalid interval or a break longer than the time on duty.
 */
export function countedMinutes(start: Date, end: Date, breakMinutes = 0): number | null {
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || end.getTime() < start.getTime()) return null;
  const elapsed = Math.floor((end.getTime() - start.getTime()) / MINUTE);
  return breakMinutes > elapsed ? null : elapsed - breakMinutes;
}

/** Half-open overlap: touching intervals (one ends as the next starts) do not overlap. */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

const grace = (shift: ShiftWindow) => shift.graceMinutes * MINUTE;

/** Check-in is open from `grace` minutes before the start until the end. */
export function canCheckInAt(shift: ShiftWindow, at: Date): boolean {
  return at.getTime() >= shift.startsAt.getTime() - grace(shift) && at.getTime() < shift.endsAt.getTime();
}

/** Check-out (and a desk-entered time) must fall within the shift and its grace on either side. */
export function withinDutyWindow(shift: ShiftWindow, at: Date): boolean {
  return at.getTime() >= shift.startsAt.getTime() - grace(shift) && at.getTime() <= shift.endsAt.getTime() + grace(shift);
}

/** Places left, or null when the shift has no limit (`capacity` 0). */
export function placesLeft(capacity: number, approved: number): number | null {
  return capacity === 0 ? null : Math.max(0, capacity - approved);
}

/** "1 hour", "1.5 hours", "0.25 hours": the {{hours}} merge tag and CSV. */
export function formatHours(minutes: number): string {
  const hours = Math.round((minutes / 60) * 100) / 100;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/** "3 h 15 min", "45 min", "0 min" for dashboards. */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
