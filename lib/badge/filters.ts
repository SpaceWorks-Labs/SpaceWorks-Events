/** Which attendees a bulk badge download includes. Shared by the panel and the route. */
export const BADGE_STATUS_FILTERS = ["confirmed", "attendees", "crew", "checked-in", "not-checked-in", "all"] as const;
export type BadgeStatusFilter = (typeof BADGE_STATUS_FILTERS)[number];

export const BADGE_STATUS_FILTER_LABELS: Record<BadgeStatusFilter, string> = {
  confirmed: "Confirmed",
  attendees: "Confirmed attendees (no crew)",
  crew: "Event crew",
  "checked-in": "Checked in",
  "not-checked-in": "Confirmed, not checked in yet",
  all: "Confirmed, waitlisted and pending",
};

export function isBadgeStatusFilter(value: unknown): value is BadgeStatusFilter {
  return typeof value === "string" && (BADGE_STATUS_FILTERS as readonly string[]).includes(value);
}
