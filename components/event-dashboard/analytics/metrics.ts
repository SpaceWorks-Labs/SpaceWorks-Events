/**
 * Pure helpers for the event Analytics tab. Free of Prisma and React so they
 * can be unit-tested. Every number comes from real counts.
 */
import { formatDate, formatTime, formatTimeRange } from "@/lib/format/datetime";
import { cachedDateTimeFormat } from "@/lib/format/intlCache";

const DAY_MS = 86_400_000;

/** Whole percentage of `part` in `whole`, or null when `whole` is empty. */
export function percentOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

export type FunnelStep = {
  key: "responded" | "going" | "checkedIn" | "feedback";
  label: string;
  /** What the step means, in plain words. */
  hint: string;
  /** Null when the step only happens after the event and nothing is recorded yet. */
  value: number | null;
  /** Bar length as a share of everyone who responded, 0..1. */
  share: number;
  /** Share of the previous step, as a whole percentage (never over 100). */
  percent: number | null;
  /** What the percentage is a share of, e.g. "responses", "going". */
  of: string | null;
  /** Shown instead of a percentage when the step is larger than the one before it. */
  note: string | null;
};

const HINTS: Record<FunnelStep["key"], string> = {
  responded: "Everyone who registered or asked to join",
  going: "Have a confirmed place",
  checkedIn: "Were checked in at the event",
  feedback: "Sent the feedback form",
};
/** How each step's share is described, relative to the step before it. */
const SHARE_OF: Record<FunnelStep["key"], string> = { responded: "", going: "responses", checkedIn: "going", feedback: "checked in" };
/** Feedback can come from anyone with the link, so it may outnumber check-ins. */
const OVERFLOW_NOTE: Partial<Record<FunnelStep["key"], string>> = { feedback: "includes people who didn't check in", checkedIn: "includes door overrides" };

/** "From sign-up to thank-you": responded → going → checked in → gave feedback. */
export function funnelSteps(input: { responded: number; going: number; checkedIn: number; feedback: number; ended: boolean }): FunnelStep[] {
  const later = (value: number) => (input.ended || value > 0 ? value : null);
  const raw: Array<Pick<FunnelStep, "key" | "label" | "value">> = [
    { key: "responded", label: "Responded", value: input.responded },
    { key: "going", label: "Going", value: input.going },
    { key: "checkedIn", label: "Checked in", value: later(input.checkedIn) },
    { key: "feedback", label: "Gave feedback", value: later(input.feedback) },
  ];
  return raw.map((step, index) => {
    const previous = index > 0 ? raw[index - 1]! : null;
    const comparable = previous && step.value != null && previous.value != null && previous.value > 0;
    const overflow = Boolean(comparable && step.value! > previous!.value!);
    const percent = comparable && !overflow ? Math.round((step.value! / previous!.value!) * 100) : null;
    return {
      ...step,
      hint: HINTS[step.key],
      share: step.value == null || input.responded <= 0 ? 0 : Math.min(1, step.value / input.responded),
      percent,
      of: percent != null ? SHARE_OF[step.key] : null,
      note: overflow ? OVERFLOW_NOTE[step.key] ?? null : null,
    };
  });
}

/** One plain sentence that reads the funnel aloud, e.g. "Of 80 responses, 62 are going and 40 checked in." */
export function funnelSentence(input: { responded: number; going: number; checkedIn: number | null; ended: boolean }): string {
  const { responded, going, checkedIn, ended } = input;
  const noun = responded === 1 ? "response" : "responses";
  const goingPart = `${going} ${ended ? (going === 1 ? "had a place" : "had places") : going === 1 ? "is going" : "are going"}`;
  if (checkedIn == null) return `Of ${responded} ${noun}, ${goingPart}.`;
  const turnout = percentOf(checkedIn, going);
  const tail = turnout != null && checkedIn <= going ? ` (${turnout}% turnout)` : "";
  return `Of ${responded} ${noun}, ${goingPart} and ${checkedIn} checked in${tail}.`;
}

/** Places left and how full the event is, or null when there is no capacity limit. */
export function capacityStatus(going: number, capacity: number | null): { left: number; percent: number; full: boolean } | null {
  if (capacity == null || capacity <= 0) return null;
  return { left: Math.max(0, capacity - going), percent: Math.min(100, Math.round((going / capacity) * 100)), full: going >= capacity };
}

export type TimelineColumn = { label: string; count: number };
export type SignupTimeline = {
  columns: TimelineColumn[];
  /** Calendar days per column (1 = one column per day). */
  intervalDays: number;
  /** Calendar days from the first sign-up to the cut-off, inclusive. */
  spanDays: number;
  total: number;
  largest: number;
};

/** Days since the epoch for the calendar date of `date` in `timeZone`. */
function localDay(date: Date, timeZone: string): number {
  const parts = cachedDateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(pick("year"), pick("month") - 1, pick("day")) / DAY_MS;
}

/** "14 Oct" for a local day index. */
function dayLabel(day: number): string {
  return cachedDateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(day * DAY_MS));
}

/**
 * Sign-ups per calendar day (in the event's timezone) from the first sign-up
 * to `until` (now, or the event's end if earlier). Long spans group days so
 * there are at most `maxColumns` columns; the last column always ends on
 * `until`'s day. Null when nobody signed up.
 */
export function signupTimeline(dates: Date[], until: Date, timeZone: string, maxColumns = 14): SignupTimeline | null {
  const inRange = dates.filter((date) => date.getTime() <= until.getTime());
  if (inRange.length === 0) return null;
  const days = inRange.map((date) => localDay(date, timeZone));
  const lastDay = localDay(until, timeZone);
  const firstDay = Math.min(...days);
  const spanDays = lastDay - firstDay + 1;
  const intervalDays = Math.max(1, Math.ceil(spanDays / maxColumns));
  const buckets = Math.ceil(spanDays / intervalDays);
  const startDay = lastDay - buckets * intervalDays + 1;
  const counts = Array.from({ length: buckets }, () => 0);
  for (const day of days) counts[Math.floor((day - startDay) / intervalDays)]! += 1;
  const columns = counts.map((count, index) => {
    const from = startDay + index * intervalDays;
    const to = from + intervalDays - 1;
    return { count, label: intervalDays === 1 ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}` };
  });
  return { columns, intervalDays, spanDays, total: inRange.length, largest: Math.max(...counts) };
}

/** Sign-ups in the seven days up to `until` (inclusive of today in the event's timezone). */
export function signupsLastWeek(dates: Date[], until: Date, timeZone: string): number {
  const lastDay = localDay(until, timeZone);
  return dates.filter((date) => date.getTime() <= until.getTime() && localDay(date, timeZone) > lastDay - 7).length;
}

/** The calendar day (in the event's timezone) with the most sign-ups; earliest wins a tie. */
export function busiestDay(dates: Date[], timeZone: string): { day: string; count: number } | null {
  const byDay = new Map<string, { count: number; first: number }>();
  for (const date of dates) {
    const key = formatDate(date, timeZone);
    const entry = byDay.get(key);
    if (entry) {
      entry.count += 1;
      entry.first = Math.min(entry.first, date.getTime());
    } else byDay.set(key, { count: 1, first: date.getTime() });
  }
  let best: { day: string; count: number; first: number } | null = null;
  for (const [day, entry] of byDay) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.first < best.first)) best = { day, ...entry };
  }
  return best ? { day: best.day, count: best.count } : null;
}

/** Groups arrival times into 15, 30 or 60 minute windows, up to 16 columns. */
export function arrivalWindows(times: Date[], timeZone: string) {
  if (times.length === 0) return null;
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
  const first = sorted[0]!.getTime();
  const last = sorted[sorted.length - 1]!.getTime();
  const minutes = [15, 30, 60, 120, 240].find((size) => (last - first) / 60_000 / size < 16) ?? 480;
  const size = minutes * 60_000;
  const start = Math.floor(first / size) * size;
  const count = Math.floor((last - start) / size) + 1;
  const columns = Array.from({ length: count }, (_, index) => ({ start: new Date(start + index * size), count: 0 }));
  for (const time of sorted) columns[Math.floor((time.getTime() - start) / size)]!.count += 1;
  const peak = columns.reduce((best, column) => (column.count > best.count ? column : best), columns[0]!);
  return {
    minutes,
    columns: columns.map((column) => ({ label: formatTime(column.start, timeZone), count: column.count })),
    peak: { label: formatTimeRange(peak.start, new Date(peak.start.getTime() + size), timeZone, { withZone: false }), count: peak.count },
    first: sorted[0]!,
  };
}

/** "2026-10-20" for `date` in `timeZone`: the calendar day short-link visits are counted under. */
export function localDateKey(date: Date, timeZone: string): string {
  return new Date(localDay(date, timeZone) * DAY_MS).toISOString().slice(0, 10);
}

export type ClickSeries = { columns: TimelineColumn[]; total: number; lastWeek: number; largest: number };

/**
 * Short-link visits per day for the `days` days up to `today` ("YYYY-MM-DD"),
 * plus the all-time total and the last seven days. Null when nobody has used
 * the link yet.
 */
export function clickSeries(rows: Array<{ day: string; count: number }>, today: string, days = 14): ClickSeries | null {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) return null;
  const end = Date.parse(`${today}T00:00:00Z`) / DAY_MS;
  const byDay = new Map(rows.map((row) => [Date.parse(`${row.day}T00:00:00Z`) / DAY_MS, row.count]));
  const columns = Array.from({ length: days }, (_, index) => {
    const day = end - (days - 1) + index;
    return { label: dayLabel(day), count: byDay.get(day) ?? 0 };
  });
  const lastWeek = columns.slice(-7).reduce((sum, column) => sum + column.count, 0);
  return { columns, total, lastWeek, largest: Math.max(1, ...columns.map((column) => column.count)) };
}

/**
 * Share of people who came to more than one event: each inner list holds the
 * attendee keys of one event. Only the aggregate leaves this function, and it
 * is withheld below `minimum` people so a small group can't be singled out.
 */
export function returningShare(attendeesPerEvent: string[][], minimum = 10): { people: number; returning: number; percent: number } | null {
  const seen = new Map<string, number>();
  for (const keys of attendeesPerEvent) for (const key of new Set(keys)) seen.set(key, (seen.get(key) ?? 0) + 1);
  if (seen.size < minimum) return null;
  const returning = [...seen.values()].filter((count) => count > 1).length;
  return { people: seen.size, returning, percent: percentOf(returning, seen.size) ?? 0 };
}
