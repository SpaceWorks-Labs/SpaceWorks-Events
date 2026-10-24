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

export function toDatetimeLocalValue(d: Date) {
  const t = new Date(d);
  const off = t.getTimezoneOffset() * 60000;
  return new Date(t.getTime() - off).toISOString().slice(0, 16);
}

/** Parse a datetime-local value as browser-local wall time, like the previous picker. */
export function fromDatetimeLocalValue(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const STEP_TITLES = ["New event: the basics", "New event: when it happens", "New event: where and how people sign up"];
export const STEP_LABELS = ["Basics", "Schedule", "Location & sign-ups"];

export function isRichTextEmpty(html: string) {
  return !new DOMParser().parseFromString(html, "text/html").body.textContent?.trim();
}
