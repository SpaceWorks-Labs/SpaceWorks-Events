import { zonedDatetimeLocalValue, zonedInputToIso } from "@/lib/timeZone";

export const timezones = [
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export const DEFAULT_TIMEZONE = "Asia/Kolkata";
const HOUR_MS = 60 * 60 * 1000;

/** Shifts a `datetime-local` wall-clock value by whole hours (calendar arithmetic, no timezone). */
export function addWallClockHours(value: string, hours: number) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return "";
  const parsed = Date.parse(`${value}:00Z`);
  return Number.isNaN(parsed) ? "" : new Date(parsed + hours * HOUR_MS).toISOString().slice(0, 16);
}

/**
 * A whole hour on the event's own clock at least 30 minutes away, as a
 * `datetime-local` value. The plain next whole hour can be seconds away, and
 * then has passed by the time the organiser clicks Create.
 */
export function nextWholeHour(timeZone: string, now = Date.now()) {
  return `${zonedDatetimeLocalValue(new Date(now + 1.5 * HOUR_MS), timeZone).slice(0, 13)}:00`;
}

/**
 * The pickers hold wall-clock times on the event's clock, never the browser's
 * or the server's. Converts them to instants and explains the first problem.
 */
export function checkSchedule(start: string, end: string, timeZone: string, now = new Date()): { error: string } | { startIso: string; endIso: string } {
  if (!start || !end) return { error: "Please select both start and end times." };
  const startIso = zonedInputToIso(start, timeZone);
  if (!startIso) return { error: `That start time does not exist in ${timeZone}.` };
  if (new Date(startIso) < now) return { error: "Start time must be now or in the future." };
  const endIso = zonedInputToIso(end, timeZone);
  if (!endIso) return { error: `That end time does not exist in ${timeZone}.` };
  if (new Date(endIso) <= new Date(startIso)) return { error: "End time must be after start time." };
  return { startIso, endIso };
}

export const STEP_TITLES = ["New event: the basics", "New event: when it happens", "New event: where and how people sign up"];
export const STEP_LABELS = ["Basics", "Schedule", "Location & sign-ups"];

export function isRichTextEmpty(html: string) {
  return !new DOMParser().parseFromString(html, "text/html").body.textContent?.trim();
}
