"use client";

import type { Dispatch, SetStateAction } from "react";
import { Check, Info, Users } from "lucide-react";
import type { CheckInResultData, LookupRow } from "@/app/actions/checkin";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/display";
import { Input } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { CheckInDetailsList, CheckInTimestamp, StatusChip } from "./parts";
import type { LastResult } from "./types";

/** The big confirmation card for the last guest checked in at this desk. */
export function LastResultCard({
  lastResult,
  setLastResult,
  idCardPrintingEnabled,
  showIdCard,
}: {
  lastResult: NonNullable<LastResult>;
  setLastResult: Dispatch<SetStateAction<LastResult>>;
  idCardPrintingEnabled: boolean;
  showIdCard: (attendee: CheckInResultData) => void;
}) {
  return (
    <section
      role="status"
      className={cn("flex flex-col gap-3 rounded-xl p-6", lastResult.kind === "already" ? "bg-emphasis text-ink" : "bg-success-bg text-success-fg")}
    >
      {lastResult.kind === "already" ? (
        <span aria-hidden className="flex size-14 items-center justify-center rounded-full bg-canvas">
          <Info className="size-6" />
        </span>
      ) : (
        <span className="flex size-14 items-center justify-center rounded-full bg-canvas text-ink">
          <Check aria-hidden className="size-7" />
        </span>
      )}
      <div>
        <p className="text-[15px] font-semibold">{lastResult.kind === "already" ? "Already checked in" : "Checked in"}</p>
        <p className="break-words font-display text-[34px] font-semibold leading-none tracking-[-0.02em]">{lastResult.displayName}</p>
        {lastResult.teamName ? <p className="mt-1.5 flex items-center gap-1.5 text-[15px] font-semibold"><Users aria-hidden className="size-4 shrink-0" /><span className="sr-only">Team: </span>{lastResult.teamName}</p> : null}
        <p className="mt-2 text-sm opacity-90">
          {lastResult.email ?? ""}
          {lastResult.email && lastResult.checkedInAt ? " · " : ""}
          {lastResult.checkedInAt ? <CheckInTimestamp value={lastResult.checkedInAt} /> : null}
        </p>
        <CheckInDetailsList details={lastResult.checkInDetails} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => setLastResult(null)}>
          Next guest
        </Button>
        {idCardPrintingEnabled ? (
          <Button size="sm" variant="primary" onClick={() => showIdCard(lastResult)}>
            Print ID card
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** Attendee search by name or email, with check-in and undo for each result. */
export function AttendeeSearch({
  lookupQuery,
  setLookupQuery,
  runLookup,
  pending,
  lookupRows,
  viewAttendee,
  onUndo,
  isOnline,
  checkInRow,
  override,
  teamEvent = false,
}: {
  lookupQuery: string;
  setLookupQuery: (value: string) => void;
  runLookup: () => void;
  pending: boolean;
  lookupRows: LookupRow[];
  viewAttendee: (row: LookupRow) => void;
  onUndo: (rsvpId: string) => void;
  isOnline: boolean;
  checkInRow: (row: LookupRow, force: boolean) => void;
  override: boolean;
  /** TEAM events: the lookup also matches team names (docs/TEAMS.md), so say so. */
  teamEvent?: boolean;
}) {
  return (
  <section aria-labelledby="search-title" className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
    <h2 id="search-title" className="text-title text-ink">Search attendees</h2>
    <div className="flex gap-2">
      <label htmlFor="check-in-search" className="sr-only">{teamEvent ? "Name, email or team" : "Name or email"}</label>
      <Input
        id="check-in-search"
        placeholder={teamEvent ? "Name, email or team" : "Name or email"}
        value={lookupQuery}
        onChange={(e) => setLookupQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            runLookup();
          }
        }}
      />
      <Button variant="primary" onClick={runLookup} disabled={pending}>
        Search
      </Button>
    </div>
    {lookupRows.length > 0 ? (
      <ul className="flex flex-col divide-y divide-line">
        {lookupRows.map((row) => (
          <li key={row.rsvpId} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <button type="button" onClick={() => viewAttendee(row)} disabled={pending} className="block max-w-full truncate text-left text-[15px] font-semibold text-ink underline-offset-4 hover:underline">
                {row.displayName}
              </button>
              {row.email ? <p className="truncate text-sm text-ink-muted">{row.email}</p> : null}
              {row.teamName ? <p className="truncate text-sm text-ink-secondary"><span className="sr-only">Team: </span>{row.teamName}</p> : null}
              <div className="mt-1 flex flex-wrap gap-1">
                <StatusChip status={row.status} />
                {row.checkedInAt ? <Chip size="sm" tone="success" icon={<Check />}>Checked in</Chip> : null}
              </div>
            </div>
            {row.checkedInAt ? (
              <Button size="sm" variant="quiet" onClick={() => onUndo(row.rsvpId)} disabled={pending || !isOnline}>Undo</Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => checkInRow(row, override)} disabled={pending}>Check in</Button>
            )}
          </li>
        ))}
      </ul>
    ) : null}
  </section>
  );
}
