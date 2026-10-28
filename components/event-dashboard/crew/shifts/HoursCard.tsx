"use client";

import { useState, type FormEvent } from "react";
import { reviewVolunteerHours } from "@/app/actions/volunteer-shifts";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader, Chip } from "@/components/ui/display";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { formatDayShort } from "@/lib/format/datetime";
import { formatDuration } from "@/lib/volunteer/math";
import type { DashboardShift } from "@/lib/eventDashboard/volunteerShifts";

type Run = (key: string, action: () => Promise<{ ok: boolean; error?: string }>, success?: string) => void;
type Row = { hoursId: string; name: string; shift: string; date: string; minutes: number; state: string; isViewer: boolean };

/**
 * Hours verification (docs/VOLUNTEERS.md): pending hours from check-out are
 * verified by an owner or admin who is not the volunteer, and verified hours
 * can be adjusted with a reason. Every change is kept and revokes an issued
 * certificate. Hours are never money.
 */
export function HoursCard({ organisationSlug, eventId, timeZone, shifts, isAdmin, busyKey, run }: {
  organisationSlug: string; eventId: string; timeZone: string; shifts: DashboardShift[]; isAdmin: boolean; busyKey: string | null; run: Run;
}) {
  const [adjusting, setAdjusting] = useState<Row | null>(null);
  const rows: Row[] = shifts.flatMap((shift) => shift.signups.flatMap((signup) => (signup.hours
    ? [{ hoursId: signup.hours.id, name: signup.name, shift: shift.title, date: formatDayShort(new Date(shift.startsAt), timeZone), minutes: signup.hours.minutes, state: signup.hours.state, isViewer: signup.isViewer }]
    : [])));
  const pending = rows.filter((row) => row.state === "PENDING").length;
  const scope = { organisationSlug, eventId };

  return (
    <Card as="section" aria-labelledby="volunteer-hours-title" className="flex flex-col gap-3">
      <CardHeader
        title={<span id="volunteer-hours-title">Hours</span>}
        titleAs="h3"
        description={pending ? `${pending} to verify. Another owner or admin verifies a volunteer's own hours.` : "Hours appear here when volunteers check out."}
        action={<Button asChild size="sm" variant="secondary"><a href={`/api/exports/events/${eventId}/volunteer-hours`}>Download hours CSV</a></Button>}
      />
      {!isAdmin && rows.length > 0 ? <Callout tone="info">Only organisation owners and admins can verify or adjust hours.</Callout> : null}
      {rows.length > 0 ? (
        <ul aria-label="Volunteer hours" className="flex flex-col divide-y divide-line">
          {rows.map((row) => (
            <li key={row.hoursId} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
              <div className="flex min-w-0 flex-[1_1_200px] flex-col">
                <span className="truncate font-semibold text-ink">{row.name}</span>
                <span className="text-caption text-ink-muted">{row.shift} · {row.date}</span>
              </div>
              <span className="text-body-ui font-semibold text-ink">{formatDuration(row.minutes)}</span>
              <Chip size="sm" tone={row.state === "PENDING" ? "warning" : "success"}>{row.state === "PENDING" ? "To verify" : row.state === "ADJUSTED" ? "Adjusted" : "Verified"}</Chip>
              {isAdmin && !row.isViewer ? (
                <div className="ml-auto flex gap-1.5">
                  {row.state === "PENDING" ? (
                    <Button size="sm" variant="secondary" loading={busyKey === row.hoursId} disabled={busyKey != null} onClick={() => run(row.hoursId, () => reviewVolunteerHours({ ...scope, hoursId: row.hoursId, action: "verify" }), `${row.name}'s hours verified`)}>Verify</Button>
                  ) : (
                    <Button size="sm" variant="quiet" disabled={busyKey != null} onClick={() => setAdjusting(row)}>Adjust</Button>
                  )}
                </div>
              ) : row.isViewer ? <span className="ml-auto text-caption text-ink-muted">Your hours: another admin verifies them</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {adjusting ? (
        <AdjustDialog
          row={adjusting}
          onClose={() => setAdjusting(null)}
          onSubmit={(minutes, reason) => {
            const row = adjusting;
            setAdjusting(null);
            run(row.hoursId, () => reviewVolunteerHours({ ...scope, hoursId: row.hoursId, action: "adjust", minutes, reason }), `${row.name}'s hours adjusted`);
          }}
        />
      ) : null}
    </Card>
  );
}

function AdjustDialog({ row, onClose, onSubmit }: { row: Row; onClose: () => void; onSubmit: (minutes: number, reason: string) => void }) {
  const [minutes, setMinutes] = useState(String(row.minutes));
  const [reason, setReason] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(Number(minutes), reason);
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form className="flex min-h-0 flex-col" onSubmit={submit}>
          <DialogHeader title={`Adjust ${row.name}'s hours`} description="The change and its reason are kept. An issued certificate is revoked; issue a new one afterwards." />
          <DialogBody className="flex flex-col gap-4">
            <Field label="Minutes" helperText="Whole minutes, up to 1440.">
              <Input type="number" inputMode="numeric" min={0} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} required />
            </Field>
            <Field label="Reason" required>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} required />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit">Save adjustment</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
