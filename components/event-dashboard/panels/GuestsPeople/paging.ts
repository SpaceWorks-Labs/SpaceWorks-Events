import type { AttendeeRow } from "@/components/attendees/types";
import type { ServerPageResult } from "@/components/event-dashboard/guests/useServerPages";
import type { AttendeesPage } from "@/lib/eventDashboard/attendees";
import { NO_COUNTS, type Meta } from "./constants";

/** The server-rendered first page as the paging hook's initial state. */
export function initialGuestList(page: AttendeesPage) {
  const meta: Meta = { counts: page.counts ?? NO_COUNTS, total: page.total ?? 0, matching: page.matching ?? 0, attendanceCounts: page.attendanceCounts ?? null };
  return { rows: page.rows as AttendeeRow[], nextCursor: page.nextCursor, meta };
}

/** One `loadAttendeesPage` answer as a page; counts come with the first page only. */
export function toGuestPage(res: { ok: true; data?: AttendeesPage } | { ok: false; error: string }): ServerPageResult<AttendeeRow, Meta> {
  if (!res.ok || !res.data) return { ok: false, error: res.ok ? "Could not load guests." : res.error };
  const { rows, nextCursor, counts, total, matching, attendanceCounts } = res.data;
  return { ok: true, page: { rows, nextCursor, meta: counts && total != null && matching != null ? { counts, total, matching, attendanceCounts } : null } };
}

/** The toast after Re-accept, by where the guest ended up. */
export function reacceptMessage(status: string | undefined) {
  if (status === "PAYMENT_REQUESTED") return "Re-accepted. They've been sent a payment link; their ticket confirms once they pay.";
  return status === "WAITLISTED" ? "Re-accepted. The event is full, so they're on the waitlist." : "Re-accepted";
}
