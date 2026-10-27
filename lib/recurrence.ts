import { RRule, rrulestr } from "rrule";
import { cachedDateTimeFormat } from "@/lib/format/intlCache";

const DEFAULT_MAX_INSTANCES = 48;
const ABSOLUTE_MAX_INSTANCES = 500;

/**
 * Expand RRULE (ICS-style string with DTSTART + RRULE) into upcoming instance windows.
 * With `timeZone`, the rule repeats on wall-clock time in that zone, so occurrences keep
 * their local time across daylight-saving changes and BYDAY/BYHOUR follow local days.
 */
export function materializeInstances(
  recurrenceIcs: string,
  instanceDurationMs: number,
  opts?: { maxInstances?: number; from?: Date; until?: Date; timeZone?: string },
): { startDateTime: Date; endDateTime: Date }[] {
  const maxInstances = Math.min(ABSOLUTE_MAX_INSTANCES, Math.max(0, Math.floor(opts?.maxInstances ?? DEFAULT_MAX_INSTANCES)));
  const from = opts?.from ?? new Date();
  const until = opts?.until ?? new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);
  const timeZone = opts?.timeZone;

  let rule;
  try {
    rule = rrulestr(recurrenceIcs, { dtstart: undefined });
  } catch {
    return [];
  }

  // Wall-clock times are expanded as if they were UTC, then mapped back into the zone.
  // Conversions keep seconds and milliseconds, so SECONDLY/BYSECOND rules survive.
  const toWall = (date: Date) => (timeZone ? new Date(date.getTime() + zoneOffsetMs(date, timeZone)) : date);
  const fromWall = (wall: Date) => {
    if (!timeZone) return wall;
    const guess = new Date(wall.getTime() - zoneOffsetMs(wall, timeZone));
    const instant = new Date(wall.getTime() - zoneOffsetMs(guess, timeZone));
    // A wall time skipped by a daylight-saving change has no instant.
    return toWall(instant).getTime() === wall.getTime() ? instant : null;
  };
  if (timeZone && rule instanceof RRule && rule.options.dtstart) {
    const { until: ruleUntil } = rule.origOptions;
    // UNTIL is a real instant; move it onto the same wall-clock basis as DTSTART.
    rule = new RRule({ ...rule.origOptions, dtstart: toWall(rule.options.dtstart), ...(ruleUntil ? { until: toWall(ruleUntil) } : {}) });
  }

  const out: { startDateTime: Date; endDateTime: Date }[] = [];
  let cursor = toWall(from);
  // A day of slack covers the zone's offset between wall-clock and real time.
  const lastWall = toWall(until).getTime() + 86_400_000;
  let inclusive = true;
  while (out.length < maxInstances) {
    const wall = rule.after(cursor, inclusive);
    if (!wall || wall.getTime() > lastWall) break;
    cursor = wall;
    inclusive = false;
    const start = fromWall(wall);
    if (!start) continue; // a local time skipped by a daylight-saving change
    if (start > until) break;
    if (start < from) continue;
    out.push({
      startDateTime: start,
      endDateTime: new Date(start.getTime() + instanceDurationMs),
    });
  }
  return out;
}

/** The zone's offset from UTC at `date`, in milliseconds (wall clock minus real time). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    cachedDateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  const wallSeconds = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wallSeconds - (date.getTime() - date.getUTCMilliseconds());
}

export function buildRecurrenceIcs(dtStart: Date, rruleLine: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = dtStart.getUTCFullYear();
  const m = pad(dtStart.getUTCMonth() + 1);
  const d = pad(dtStart.getUTCDate());
  const hh = pad(dtStart.getUTCHours());
  const mm = pad(dtStart.getUTCMinutes());
  const ss = pad(dtStart.getUTCSeconds());
  const dt = `${y}${m}${d}T${hh}${mm}${ss}Z`;
  const line = rruleLine.trim().startsWith("RRULE:")
    ? rruleLine.trim()
    : `RRULE:${rruleLine.trim()}`;
  return `DTSTART:${dt}\n${line}`;
}
