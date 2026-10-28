import { cachedDateTimeFormat } from "@/lib/format/intlCache";

/** Zones already found invalid, so a bad legacy value is not retried on every render. Bounded. */
const invalidZones = new Set<string>();

export function isValidTimeZone(value: string) {
  if (invalidZones.has(value)) return false;
  try {
    // A valid zone reuses the cached formatter instead of building one per call.
    cachedDateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    if (invalidZones.size >= 256) invalidZones.clear();
    invalidZones.add(value);
    return false;
  }
}

/** Protect render paths from legacy rows written before timezone validation. */
export function safeTimeZone(value: string) {
  return isValidTimeZone(value) ? value : "UTC";
}

export function zonedDatetimeLocalValue(date: Date, timeZone: string) {
  if (Number.isNaN(date.getTime())) return "";
  const parts = cachedDateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Converts a datetime-local value in an IANA timezone into a UTC ISO instant. */
export function zonedInputToIso(value: string, timeZone: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const guess = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  // The offset at the guess differs from the offset at the real instant when
  // a DST change falls between them, so take it again at the first answer.
  const first = guess - zoneOffsetAt(guess, timeZone);
  const second = guess - zoneOffsetAt(first, timeZone);
  for (const candidate of second === first ? [first] : [second, first]) {
    const iso = new Date(candidate).toISOString();
    // A wall-clock time a DST change skips never round-trips, so it stays null.
    if (zonedDatetimeLocalValue(new Date(iso), timeZone) === value) return iso;
  }
  return null;
}

/** Milliseconds the zone's wall clock is ahead of UTC at an instant. */
function zoneOffsetAt(instant: number, timeZone: string) {
  const parts = cachedDateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wholeMinute = Math.floor(instant / 60_000) * 60_000;
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - wholeMinute;
}

/**
 * An instant as ISO 8601 local time in an IANA timezone with its UTC offset,
 * e.g. `2026-10-25T14:30:00+05:30` (`+00:00` for UTC). Machine-readable like
 * `toISOString()`, but it reads as the event's own clock (CSV exports).
 */
export function zonedIsoWithOffset(date: Date, timeZone: string) {
  if (Number.isNaN(date.getTime())) return "";
  const parts = cachedDateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const wholeSeconds = Math.floor(date.getTime() / 1000) * 1000;
  const local = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")), Number(get("hour")), Number(get("minute")), Number(get("second")));
  const offsetMinutes = Math.round((local - wholeSeconds) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}
