/*
 * Pure Mentor Desk rules (docs/MENTOR_DESK.md), ported from the Space Works
 * platform design (mentoring/policy.py, help_expiry.py, round_workflow.py).
 * No database or framework imports, so they are unit tested directly and
 * shared by the cores, the views and the forms.
 */

export const MENTOR_SKILLS_MAX = 8;
export const MENTOR_SKILL_MAX_LENGTH = 30;
export const MENTOR_BIO_MAX_LENGTH = 600;
export const MENTOR_AFFILIATION_MAX_LENGTH = 200;
export const MENTOR_AVAILABILITY_MAX = 20;
export const MENTOR_MAX_TEAMS_MIN = 1;
export const MENTOR_MAX_TEAMS_MAX = 100;

export const HELP_CATEGORIES_MAX = 20;
export const HELP_OPEN_LIMIT = { min: 1, max: 10 } as const;
export const HELP_CLAIM_MINUTES = { min: 1, max: 60 } as const;
export const HELP_EXPIRY_MINUTES = { min: 15, max: 10080 } as const;
export const HELP_PRIORITY_MAX = 100;
export const HELP_SUMMARY_MAX_LENGTH = 1000;
export const HELP_LOCATION_MAX_LENGTH = 120;
export const HELP_COMMENT_MAX_LENGTH = 2000;
export const HELP_NOTE_MAX_LENGTH = 500;
/** Assigned mentors see a new or reopened request first, for this long. */
export const HELP_PRIORITY_WINDOW_MS = 5 * 60_000;
/** The beat's batch size per run (help_expiry.expire limit). */
export const HELP_EXPIRY_BATCH = 100;

export const OFFICE_HOUR_CAPACITY_MAX = 50;
export const OFFICE_HOUR_LOCATION_MAX_LENGTH = 120;
export const OFFICE_HOUR_REASON_MAX_LENGTH = 300;

export const ROUND_LABEL_MAX_LENGTH = 100;
export const ROUNDS_MAX = 20;
/** A round visit is a ten-minute heartbeat lease (round_workflow.LEASE_TTL). */
export const VISIT_LEASE_MS = 10 * 60_000;
export const OVERRIDE_REASON_MAX_LENGTH = 300;
export const CONFLICT_REASON_MAX_LENGTH = 300;

export type HelpStatus = "OPEN" | "CLAIMED" | "RESOLVED" | "CANCELLED" | "EXPIRED";

/** A request's hard deadline: its own expiry or the event's end, whichever is first. */
export function helpDeadline(expiresAt: Date, eventEnd: Date): Date {
  return expiresAt.getTime() <= eventEnd.getTime() ? expiresAt : eventEnd;
}

/** When a new request expires: its category's expiry, never after the event ends. */
export function helpExpiresAt(now: Date, expiryMinutes: number, eventEnd: Date): Date {
  return helpDeadline(new Date(now.getTime() + expiryMinutes * 60_000), eventEnd);
}

/** A claim whose lease has not lapsed. */
export function isLiveClaim(row: { status: HelpStatus; claimExpiresAt: Date | null }, at: Date): boolean {
  return row.status === "CLAIMED" && row.claimExpiresAt !== null && row.claimExpiresAt.getTime() > at.getTime();
}

/** A claim (or renewal) lasts the category's claim minutes, never past the deadline. */
export function claimLeaseExpiry(now: Date, claimMinutes: number, deadline: Date): Date {
  return new Date(Math.min(deadline.getTime(), now.getTime() + claimMinutes * 60_000));
}

export type HelpLiveness = "ok" | "expired" | "lease-lost";

/** help_expiry.require_live: commands re-check the clock instead of trusting the beat. */
export function helpLiveness(row: { status: HelpStatus; claimExpiresAt: Date | null; expiresAt: Date }, eventEnd: Date, now: Date): HelpLiveness {
  if (row.status === "EXPIRED" || helpDeadline(row.expiresAt, eventEnd).getTime() <= now.getTime()) return "expired";
  if (row.status === "CLAIMED" && !isLiveClaim(row, now)) return "lease-lost";
  return "ok";
}

/** What the expiry beat does with one due row: terminal expiry, a lapsed claim back to OPEN, or nothing. */
export function expiryAction(row: { status: HelpStatus; claimExpiresAt: Date | null; expiresAt: Date }, eventEnd: Date, now: Date): "expire" | "release" | null {
  if (row.status !== "OPEN" && row.status !== "CLAIMED") return null;
  if (helpDeadline(row.expiresAt, eventEnd).getTime() <= now.getTime()) return "expire";
  if (row.status === "CLAIMED" && !isLiveClaim(row, now)) return "release";
  return null;
}

export type AvailabilityWindow = { startsAt: string; endsAt: string };

/** Reads a stored availability list, dropping anything malformed. */
export function parseAvailability(value: unknown): AvailabilityWindow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { startsAt, endsAt } = item as Record<string, unknown>;
    if (typeof startsAt !== "string" || typeof endsAt !== "string") return [];
    const start = Date.parse(startsAt);
    const end = Date.parse(endsAt);
    return Number.isFinite(start) && Number.isFinite(end) && start < end ? [{ startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() }] : [];
  });
}

/** policy.in_windows: start <= at < end for some window. An empty list means off duty. */
export function inWindows(windows: readonly AvailabilityWindow[], at: Date): boolean {
  const t = at.getTime();
  return windows.some((w) => Date.parse(w.startsAt) <= t && t < Date.parse(w.endsAt));
}

/** policy.covers_interval: one window holds the whole interval. */
export function coversInterval(windows: readonly AvailabilityWindow[], start: Date, end: Date): boolean {
  return windows.some((w) => Date.parse(w.startsAt) <= start.getTime() && end.getTime() <= Date.parse(w.endsAt));
}

/** Every window lies inside the event (configuration_workflow.save_profile). */
export function windowsInsideEvent(windows: readonly AvailabilityWindow[], eventStart: Date, eventEnd: Date): boolean {
  return windows.every((w) => eventStart.getTime() <= Date.parse(w.startsAt) && Date.parse(w.endsAt) <= eventEnd.getTime());
}

/** A visit lease lasts ten minutes, never past the round's close. */
export function visitLeaseExpiry(now: Date, closesAt: Date): Date {
  return new Date(Math.min(now.getTime() + VISIT_LEASE_MS, closesAt.getTime()));
}

/** Lowercased, trimmed, deduplicated tags (skills and category skill tags). */
export function normaliseTags(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean))];
}

/**
 * policy.visit_eligible after the team/conflict checks: an assigned mentor
 * always qualifies; while an assigned mentor's priority window is open,
 * others wait; otherwise the category's skill tags (if any) must overlap.
 */
export function skillAndPriorityEligible(params: {
  assignedToMentor: boolean;
  teamHasAssignedMentor: boolean;
  priorityUntil: Date | null;
  now: Date;
  mentorSkills: readonly string[];
  skillTags: readonly string[];
}): boolean {
  if (params.assignedToMentor) return true;
  if (params.teamHasAssignedMentor && params.priorityUntil && params.now.getTime() < params.priorityUntil.getTime()) return false;
  if (params.skillTags.length === 0) return true;
  const skills = new Set(params.mentorSkills);
  return params.skillTags.some((tag) => skills.has(tag));
}
