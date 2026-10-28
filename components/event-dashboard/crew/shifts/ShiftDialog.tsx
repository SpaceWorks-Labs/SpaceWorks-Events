"use client";

import { useState, type FormEvent } from "react";
import { saveVolunteerShift } from "@/app/actions/volunteer-shifts";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/choice";
import { Callout } from "@/components/ui/display";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { zonedDatetimeLocalValue, zonedInputToIso } from "@/lib/timeZone";
import type { DashboardShift } from "@/lib/eventDashboard/volunteerShifts";

/**
 * Create or edit a volunteer shift (docs/VOLUNTEERS.md). Times are entered in
 * the event's timezone. The server re-validates every rule: the window, up to
 * 12 hours, the sign-up deadline at or before the start, grace up to 60
 * minutes and places never below those already given.
 */
export function ShiftDialog({ organisationSlug, eventId, timeZone, shift, onClose, onSaved }: {
  organisationSlug: string; eventId: string; timeZone: string; shift: DashboardShift | null; onClose: () => void; onSaved: (message: string) => void;
}) {
  const local = (iso: string | undefined) => (iso ? zonedDatetimeLocalValue(new Date(iso), timeZone) : "");
  const [title, setTitle] = useState(shift?.title ?? "");
  const [zone, setZone] = useState(shift?.zone ?? "");
  const [task, setTask] = useState(shift?.task ?? "");
  const [startsAt, setStartsAt] = useState(local(shift?.startsAt));
  const [endsAt, setEndsAt] = useState(local(shift?.endsAt));
  const [deadline, setDeadline] = useState(local(shift?.signupDeadline));
  const [capacity, setCapacity] = useState(String(shift?.capacity ?? 0));
  const [grace, setGrace] = useState(String(shift?.graceMinutes ?? 15));
  const [requiresApproval, setRequiresApproval] = useState(shift?.requiresApproval ?? true);
  const [waitlistEnabled, setWaitlistEnabled] = useState(shift?.waitlistEnabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const start = zonedInputToIso(startsAt, timeZone);
    const end = zonedInputToIso(endsAt, timeZone);
    const close = deadline ? zonedInputToIso(deadline, timeZone) : start;
    if (!start || !end || !close) {
      setError("Enter a valid start, end and sign-up deadline.");
      return;
    }
    setBusy(true);
    setError(null);
    const values = { title, zone, task, startsAt: start, endsAt: end, signupDeadline: close, capacity: Number(capacity) || 0, graceMinutes: Number(grace) || 0, requiresApproval, waitlistEnabled };
    const result = await saveVolunteerShift({ organisationSlug, eventId, ...(shift ? { shiftId: shift.id } : {}), shift: values });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved(shift ? "Shift updated" : "Shift added");
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent size="md">
        <form className="flex min-h-0 flex-col" onSubmit={submit} aria-busy={busy || undefined}>
          <DialogHeader title={shift ? "Edit shift" : "Add shift"} description={`Times are in the event's timezone (${timeZone}).`} />
          <DialogBody className="flex flex-col gap-4">
            {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
            <Field label="Title" required>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Zone" optional helperText="Where, for example Hall A">
                <Input value={zone} onChange={(e) => setZone(e.target.value)} maxLength={100} />
              </Field>
              <Field label="Task" optional helperText="What, for example Badge desk">
                <Input value={task} onChange={(e) => setTask(e.target.value)} maxLength={200} />
              </Field>
              <Field label="Starts" required>
                <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
              </Field>
              <Field label="Ends" required helperText="Up to 12 hours after the start.">
                <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
              </Field>
              <Field label="Sign-ups close" optional helperText="By the start. Empty closes at the start.">
                <Input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </Field>
              <Field label="Places" helperText="0 means no limit.">
                <Input type="number" inputMode="numeric" min={0} max={10000} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
              </Field>
              <Field label="Check-in grace (minutes)" helperText="Volunteers can check in this long before the start, and out this long after the end. Up to 60.">
                <Input type="number" inputMode="numeric" min={0} max={60} value={grace} onChange={(e) => setGrace(e.target.value)} />
              </Field>
            </div>
            <CheckboxField label="Organisers approve each sign-up" description="Off: crew get a place as soon as they sign up." checked={requiresApproval} onCheckedChange={(checked) => setRequiresApproval(checked === true)} />
            <CheckboxField label="Keep a waitlist when full" description="Places that open up go to the waitlist first in, first out." checked={waitlistEnabled} onCheckedChange={(checked) => setWaitlistEnabled(checked === true)} />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" type="submit" loading={busy}>{shift ? "Save shift" : "Add shift"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
