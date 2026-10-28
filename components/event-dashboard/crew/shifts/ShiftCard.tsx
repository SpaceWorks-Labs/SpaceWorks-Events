"use client";

import { useState } from "react";
import { Lock, LockOpen, Pencil, Trash2 } from "lucide-react";
import { closeVolunteerShift, decideVolunteerSignup, deleteVolunteerShift, recordVolunteerAttendance } from "@/app/actions/volunteer-shifts";
import { ConfirmationDialog } from "@/components/feedback/ConfirmationDialog";
import { Button, IconButton } from "@/components/ui/button";
import { Card, Chip, type ChipTone } from "@/components/ui/display";
import { crewKindLabel } from "@/lib/crewKind";
import { formatDayShort, formatTime, formatTimeRange } from "@/lib/format/datetime";
import { formatDuration } from "@/lib/volunteer/math";
import type { DashboardShift, DashboardSignup } from "@/lib/eventDashboard/volunteerShifts";
import { DeskDialog } from "./DeskDialog";

type Run = (key: string, action: () => Promise<{ ok: boolean; error?: string }>, success?: string) => void;

const STATUS: Record<string, { label: string; tone: ChipTone }> = {
  APPLIED: { label: "Waiting for approval", tone: "info" },
  WAITLISTED: { label: "Waitlisted", tone: "warning" },
  APPROVED: { label: "Has a place", tone: "success" },
  WITHDRAWN: { label: "Withdrew", tone: "outline" },
  DECLINED: { label: "Declined", tone: "outline" },
};
const ATTENDANCE: Record<string, { label: string; tone: ChipTone } | null> = {
  SCHEDULED: null,
  CHECKED_IN: { label: "On shift", tone: "accent" },
  CHECKED_OUT: { label: "Checked out", tone: "neutral" },
  NO_SHOW: { label: "No-show", tone: "danger" },
};

/**
 * One shift in Guests → Crew → Shifts (docs/VOLUNTEERS.md): its window and
 * places, the roster with approvals, and the attendance desk. Every action
 * re-checks the crew rule on the server.
 */
export function ShiftCard({ organisationSlug, eventId, timeZone, shift, now, busyKey, run, onEdit }: {
  organisationSlug: string; eventId: string; timeZone: string; shift: DashboardShift; now: string; busyKey: string | null; run: Run; onEdit: () => void;
}) {
  const [desk, setDesk] = useState<{ signup: DashboardSignup; action: "check-in" | "check-out" } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const scope = { organisationSlug, eventId };
  const start = new Date(shift.startsAt);
  const ended = new Date(shift.endsAt) <= new Date(now);
  const started = start <= new Date(now);
  const active = shift.signups.filter((signup) => signup.status !== "WITHDRAWN");
  const places = shift.capacity === 0 ? `${shift.approved} with a place · no limit` : `${shift.approved} of ${shift.capacity} places`;

  return (
    <Card as="section" aria-labelledby={`shift-${shift.id}`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`shift-${shift.id}`} className="text-h4 text-ink">{shift.title}</h3>
          <p className="text-caption text-ink-secondary">
            {formatDayShort(start, timeZone)} · {formatTimeRange(start, new Date(shift.endsAt), timeZone, { withZone: true })}
            {shift.zone ? ` · ${shift.zone}` : ""}
            {shift.task ? ` · ${shift.task}` : ""}
          </p>
          <p className="text-caption text-ink-muted">
            {places} · sign-ups close {formatDayShort(new Date(shift.signupDeadline), timeZone)} {formatTime(new Date(shift.signupDeadline), timeZone)}
            {shift.requiresApproval ? " · approval needed" : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {shift.closed ? <Chip size="sm" tone="outline">Closed</Chip> : null}
          <IconButton size="sm" label={`Edit ${shift.title}`} onClick={onEdit}><Pencil /></IconButton>
          <IconButton size="sm" label={shift.closed ? `Reopen ${shift.title}` : `Close ${shift.title}`} disabled={busyKey != null} onClick={() => run(shift.id, () => closeVolunteerShift({ ...scope, shiftId: shift.id, closed: !shift.closed }), shift.closed ? "Shift reopened" : "Shift closed to sign-ups")}>
            {shift.closed ? <LockOpen /> : <Lock />}
          </IconButton>
          <IconButton size="sm" variant="danger" label={`Delete ${shift.title}`} disabled={busyKey != null} onClick={() => setDeleting(true)}><Trash2 /></IconButton>
        </div>
      </div>

      {active.length === 0 ? (
        <p className="text-body-ui text-ink-muted">No sign-ups yet. Crew sign up from their crew ticket.</p>
      ) : (
        <ul aria-label={`Volunteers for ${shift.title}`} className="flex flex-col divide-y divide-line">
          {active.map((signup) => {
            const status = STATUS[signup.status];
            const attendance = ATTENDANCE[signup.attendance];
            const busy = busyKey === signup.id;
            const decide = (decision: "approve" | "decline" | "cancel", success: string) => run(signup.id, () => decideVolunteerSignup({ ...scope, signupId: signup.id, decision }), success);
            return (
              <li key={signup.id} aria-busy={busy || undefined} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                <div className="flex min-w-0 flex-[1_1_200px] flex-col">
                  <span className="truncate font-semibold text-ink">{signup.name}</span>
                  <span className="text-caption text-ink-muted">
                    {crewKindLabel(signup.kind)}
                    {signup.checkedInAt ? ` · in ${formatTime(new Date(signup.checkedInAt), timeZone)}` : ""}
                    {signup.checkedOutAt ? ` · out ${formatTime(new Date(signup.checkedOutAt), timeZone)}` : ""}
                    {signup.breakMinutes ? ` · ${signup.breakMinutes} min break` : ""}
                    {signup.hours ? ` · ${formatDuration(signup.hours.minutes)} ${signup.hours.state === "PENDING" ? "(to verify)" : "verified"}` : ""}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {status ? <Chip size="sm" tone={status.tone}>{status.label}</Chip> : null}
                  {attendance ? <Chip size="sm" tone={attendance.tone}>{attendance.label}</Chip> : null}
                </div>
                <div className="ml-auto flex flex-wrap gap-1.5">
                  {(signup.status === "APPLIED" || signup.status === "WAITLISTED") && !started && !shift.closed ? (
                    <Button size="sm" variant="secondary" loading={busy} disabled={busyKey != null} onClick={() => decide("approve", `${signup.name} approved`)}>Approve</Button>
                  ) : null}
                  {signup.status === "APPLIED" || signup.status === "WAITLISTED" ? (
                    <Button size="sm" variant="quiet" disabled={busyKey != null} onClick={() => decide("decline", `${signup.name} declined`)}>Decline</Button>
                  ) : null}
                  {signup.status === "APPROVED" && signup.attendance === "SCHEDULED" && !ended ? (
                    <Button size="sm" variant="secondary" disabled={busyKey != null} onClick={() => setDesk({ signup, action: "check-in" })}>Check in</Button>
                  ) : null}
                  {signup.attendance === "CHECKED_IN" ? (
                    <Button size="sm" variant="secondary" disabled={busyKey != null} onClick={() => setDesk({ signup, action: "check-out" })}>Check out</Button>
                  ) : null}
                  {signup.status === "APPROVED" && signup.attendance === "SCHEDULED" && ended ? (
                    <Button size="sm" variant="quiet" disabled={busyKey != null} onClick={() => run(signup.id, () => recordVolunteerAttendance({ ...scope, signupId: signup.id, action: "no-show" }), `${signup.name} marked as a no-show`)}>No-show</Button>
                  ) : null}
                  {signup.status === "APPROVED" && signup.attendance === "SCHEDULED" && !started ? (
                    <Button size="sm" variant="dangerQuiet" disabled={busyKey != null} onClick={() => decide("cancel", `${signup.name}'s place cancelled`)}>Cancel place</Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {desk ? (
        <DeskDialog
          organisationSlug={organisationSlug} eventId={eventId} timeZone={timeZone} signupId={desk.signup.id} name={desk.signup.name} action={desk.action}
          onClose={() => setDesk(null)}
          onDone={(message) => { setDesk(null); run("desk", async () => ({ ok: true }), message); }}
        />
      ) : null}
      <ConfirmationDialog
        open={deleting}
        title="Delete this shift?"
        message="Volunteers with a place or on the waitlist are emailed that it is cancelled. A shift someone has worked can't be deleted: close it instead."
        confirmLabel="Delete shift"
        onCancel={() => setDeleting(false)}
        onConfirm={() => { setDeleting(false); run(shift.id, () => deleteVolunteerShift({ ...scope, shiftId: shift.id }), "Shift deleted"); }}
      />
    </Card>
  );
}
