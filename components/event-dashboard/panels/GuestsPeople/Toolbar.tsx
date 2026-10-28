"use client";

import type { Dispatch, SetStateAction } from "react";
import { AtSign, Download, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dropdown, SearchInput } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { GUEST_FILTERS, type GuestKindFilter, type GuestStatusFilter, type GuestTeamFilter } from "@/components/event-dashboard/guests/guestList";
import type { AttendeeAttendanceCounts, AttendeeFilterCounts } from "@/lib/eventDashboard/attendees";
import { ATTENDEE_ATTENDANCE_FILTERS, type AttendeeAttendanceFilter } from "@/lib/attendeeListQuery";
import { ATTENDANCE_STATE_LABELS } from "@/lib/attendanceCheck";
import type { SavedViewDto, ViewParams } from "@/lib/savedViews";
import { SavedViewsMenu } from "@/components/event-dashboard/views/SavedViewsMenu";
import { FILTER_DOTS } from "./constants";

/** Saved views, the two filtered exports and Add guest, on an event's list. */
export function GuestsHeaderActions({
  organisationSlug,
  eventId,
  savedViews,
  viewParams,
  applyView,
  teamMode,
  emailExportHref,
  csvExportHref,
  shownTotal,
  setManualRsvpOpen,
}: {
  organisationSlug: string;
  eventId: string;
  savedViews: SavedViewDto[] | undefined;
  viewParams: ViewParams;
  applyView: (params: ViewParams) => void;
  teamMode: boolean;
  emailExportHref: string | null;
  csvExportHref: string | null;
  shownTotal: number;
  setManualRsvpOpen: (open: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {savedViews ? (
        <SavedViewsMenu
          surface="GUESTS_PEOPLE"
          scope={{ organisationSlug, eventId }}
          params={viewParams}
          onApply={applyView}
          initialViews={savedViews}
          teamMode={teamMode}
        />
      ) : null}
      {emailExportHref && shownTotal > 0 ? (
        <Button asChild variant="secondary" startIcon={<AtSign />}>
          <a href={emailExportHref} title="Export emails for every guest matching these filters">Export emails</a>
        </Button>
      ) : (
        <Button variant="secondary" startIcon={<AtSign />} disabled title="No guests match these filters">
          Export emails
        </Button>
      )}
      {csvExportHref && shownTotal > 0 ? (
        <Button asChild variant="secondary" startIcon={<Download />}>
          <a href={csvExportHref} title="Export every guest matching these filters, with their answers">Export CSV</a>
        </Button>
      ) : (
        <Button variant="secondary" startIcon={<Download />} disabled title="No guests match these filters">
          Export CSV
        </Button>
      )}
      <Button variant="primary" startIcon={<Plus />} onClick={() => setManualRsvpOpen(true)}>
        Add guest
      </Button>
    </div>
  );
}

/** Status chips with counts, the registration-type, attendance and team dropdowns, and the search box. */
export function GuestFilters({
  status,
  setStatus,
  counts,
  kind,
  setKind,
  teamMode,
  team,
  setTeam,
  query,
  setQuery,
  attendance,
  setAttendance,
  attendanceCounts,
}: {
  status: GuestStatusFilter;
  setStatus: Dispatch<SetStateAction<GuestStatusFilter>>;
  counts: AttendeeFilterCounts;
  kind: GuestKindFilter;
  setKind: Dispatch<SetStateAction<GuestKindFilter>>;
  teamMode: boolean;
  team: GuestTeamFilter;
  setTeam: Dispatch<SetStateAction<GuestTeamFilter>>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  /** Attendance confirmation reply (docs/ATTENDANCE.md); null hides the dropdown. */
  attendance: AttendeeAttendanceFilter | null;
  setAttendance: (value: AttendeeAttendanceFilter) => void;
  attendanceCounts: AttendeeAttendanceCounts | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
        {GUEST_FILTERS.map(({ value, label }) => {
          const on = status === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              onClick={() => setStatus(value)}
              className={cn(
                "inline-flex min-h-[38px] items-center gap-2 rounded-full border px-3.5 text-sm font-semibold transition-colors",
                on ? "border-primary bg-primary text-on-primary" : "border-line-strong bg-panel text-ink hover:bg-subtle",
              )}
            >
              <span aria-hidden className={cn("size-2 rounded-full", value === "all" && on ? "bg-on-primary" : FILTER_DOTS[value])} />
              {label}
              <span className="font-medium tabular-nums">{counts[value]}</span>
            </button>
          );
        })}
      </div>
      <div className="flex w-full min-w-0 flex-wrap gap-2 sm:ml-auto sm:w-auto xl:flex-nowrap">
        <div className="min-w-0 flex-1 sm:w-[160px] sm:flex-none">
          <label htmlFor="guest-kind" className="sr-only">Registration type</label>
          <Dropdown id="guest-kind" value={kind} onChange={(event) => setKind(event.target.value as GuestKindFilter)} className="py-2 sm:text-sm">
            <option value="all">Everyone</option>
            <option value="guests">Guests only</option>
            <option value="users">Signed-in users</option>
          </Dropdown>
        </div>
        {attendance != null ? (
          <div className="min-w-0 flex-1 sm:w-[190px] sm:flex-none">
            <label htmlFor="guest-attendance" className="sr-only">Attendance confirmation</label>
            <Dropdown id="guest-attendance" value={attendance} onChange={(event) => setAttendance(event.target.value as AttendeeAttendanceFilter)} className="py-2 sm:text-sm">
              {ATTENDEE_ATTENDANCE_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "Any attendance reply" : ATTENDANCE_STATE_LABELS[value]}
                  {attendanceCounts && value !== "all" ? ` (${attendanceCounts[value]})` : ""}
                </option>
              ))}
            </Dropdown>
          </div>
        ) : null}
        {teamMode ? (
          <div className="min-w-0 flex-1 sm:w-[140px] sm:flex-none">
            <label htmlFor="guest-team" className="sr-only">Team</label>
            <Dropdown id="guest-team" value={team} onChange={(event) => setTeam(event.target.value as GuestTeamFilter)} className="py-2 sm:text-sm">
              <option value="all">Teams and solo</option>
              <option value="team">In a team</option>
              <option value="solo">Solo</option>
            </Dropdown>
          </div>
        ) : null}
        <div className="w-full min-w-0 sm:w-[260px]">
          <label htmlFor="guest-search" className="sr-only">Search guests by name or email</label>
          <SearchInput
            id="guest-search"
            placeholder={teamMode ? "Search name, email or team" : "Search name or email"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClear={() => setQuery("")}
            autoComplete="off"
            className="py-2 sm:text-sm"
          />
        </div>
      </div>
    </div>
  );
}
