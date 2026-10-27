import type { GuestKindFilter, GuestStatusFilter, GuestTeamFilter } from "@/components/event-dashboard/guests/guestList";
import type { AttendeeFilterCounts } from "@/lib/eventDashboard/attendees";

export const SEARCH_DELAY_MS = 300;

export const NO_COUNTS: AttendeeFilterCounts = { all: 0, going: 0, waitlist: 0, approve: 0, declined: 0, checkedIn: 0, notCheckedIn: 0 };

export type View = { status: GuestStatusFilter; kind: GuestKindFilter; team: GuestTeamFilter; query: string };
export type Meta = { counts: AttendeeFilterCounts; total: number; matching: number };

export const FILTER_DOTS: Record<GuestStatusFilter, string> = {
  all: "bg-ink",
  going: "bg-success-solid",
  waitlist: "bg-warning-solid",
  approve: "bg-highlight",
  declined: "bg-danger-fg",
  checkedIn: "bg-primary",
  notCheckedIn: "bg-ink-muted",
};

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Whose registrations the list shows. A one-off event gets the full toolset;
 * a series date (RSVPs keyed by `eventInstanceId`) only gets the actions that
 * accept an instance id, so manual add, the CSV/email exports and undo
 * check-in are hidden there.
 */
export type GuestListTarget =
  | { kind: "event"; eventId: string; eventTitle: string }
  | { kind: "instance"; instanceId: string; seriesId: string };
