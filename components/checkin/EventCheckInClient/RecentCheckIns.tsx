"use client";

import { Check, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { CheckInTimestamp } from "./parts";
import type { RecentCheckInsState } from "./useRecentCheckIns";

/** The latest check-ins with undo, as a list on phones and a table on wider screens. */
export function RecentCheckIns({
  stationMode,
  attendeeExportHref,
  checkedIn,
  recent,
  onUndo,
  pending,
  isOnline,
}: {
  stationMode: boolean;
  /** The full attendee CSV, for operators allowed to export it; null hides the download. */
  attendeeExportHref: string | null;
  checkedIn: number;
  recent: RecentCheckInsState;
  onUndo: (rsvpId: string) => void;
  pending: boolean;
  isOnline: boolean;
}) {
  return (
    <section aria-labelledby="recent-title" className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="recent-title" className="text-h4 text-ink">Recent check-ins</h2>
          {!stationMode ? <p className="text-caption text-ink-muted">This page refreshes automatically while it is open.{attendeeExportHref ? " The attendee CSV includes every check-in time." : ""}</p> : null}
        </div>
        {attendeeExportHref ? (
          <Button asChild size="sm" variant="secondary" startIcon={<Download />}>
            <a href={attendeeExportHref}>Download attendee CSV</a>
          </Button>
        ) : null}
      </div>
      {recent.rows.length === 0 ? (
        <p className="text-body-ui text-ink-muted">No check-ins yet.</p>
      ) : (
        <>
          <ul id={recent.listId} className="flex flex-col divide-y divide-line rounded-lg border border-line bg-canvas px-4 sm:hidden">
            {recent.rows.map((r) => (
              <li key={r.rsvpId} className="flex items-center gap-3 py-3">
                <Check aria-hidden className="size-4 shrink-0 text-success-fg" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold text-ink">{r.displayName}</p>
                  {r.email ? <p className="truncate text-sm text-ink-muted">{r.email}</p> : null}
                  <p className="text-caption text-ink-muted"><CheckInTimestamp value={r.checkedInAt} /></p>
                </div>
                <Button size="sm" variant="quiet" onClick={() => onUndo(r.rsvpId)} disabled={pending || !isOnline} aria-label={`Undo check-in for ${r.displayName}`}>Undo check-in</Button>
              </li>
            ))}
          </ul>
          <div className="hidden sm:block">
            <Table label="Recent check-ins">
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH>Email</TH>
                  <TH>Checked in</TH>
                  <TH className="text-right">Undo</TH>
                </tr>
              </THead>
              <TBody id={recent.tableId}>
                {recent.rows.map((r) => (
                  <TR key={r.rsvpId}>
                    <TD className="font-semibold">{r.displayName}</TD>
                    <TD className="text-ink-secondary">{r.email ?? "—"}</TD>
                    <TD className="text-ink-secondary"><CheckInTimestamp value={r.checkedInAt} /></TD>
                    <TD className="text-right">
                      <Button size="sm" variant="quiet" onClick={() => onUndo(r.rsvpId)} disabled={pending || !isOnline} aria-label={`Undo check-in for ${r.displayName}`}>Undo</Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-secondary">
            <span aria-live="polite">Showing {recent.rows.length} of {Math.max(checkedIn, recent.rows.length)} checked in</span>
            {recent.hasMore ? (
              <Button size="sm" variant="secondary" loading={recent.loadingOlder} loadingLabel="Loading…" onClick={() => void recent.loadOlder()}>
                Load more
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
