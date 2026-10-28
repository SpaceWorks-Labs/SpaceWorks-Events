"use client";

import { useState, type FormEvent } from "react";
import { recordVolunteerAttendance } from "@/app/actions/volunteer-shifts";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/display";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { zonedDatetimeLocalValue, zonedInputToIso } from "@/lib/timeZone";

/**
 * The attendance desk (docs/VOLUNTEERS.md): check a volunteer in or out now,
 * or at an earlier time with a reason (kept in an append-only correction).
 * Breaks are recorded at check-out. Shift attendance never touches the
 * event check-in.
 */
export function DeskDialog({ organisationSlug, eventId, timeZone, signupId, name, action, onClose, onDone }: {
  organisationSlug: string; eventId: string; timeZone: string; signupId: string; name: string; action: "check-in" | "check-out"; onClose: () => void; onDone: (message: string) => void;
}) {
  const [opened] = useState(() => zonedDatetimeLocalValue(new Date(), timeZone));
  const [time, setTime] = useState(opened);
  const [reason, setReason] = useState("");
  const [breakMinutes, setBreakMinutes] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Any time other than the one shown on opening is a desk-entered time and needs a reason.
  const earlier = time !== opened;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const occurredAt = earlier ? zonedInputToIso(time, timeZone) : null;
    if (earlier && !occurredAt) {
      setError("Enter a valid time.");
      return;
    }
    setBusy(true);
    setError(null);
    const desk = { ...(occurredAt ? { occurredAt, reason } : {}), ...(action === "check-out" ? { breakMinutes: Number(breakMinutes) || 0 } : {}) };
    const result = await recordVolunteerAttendance({ organisationSlug, eventId, signupId, action, desk });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onDone(action === "check-in" ? `${name} checked in to the shift` : `${name} checked out. Their hours wait for verification.`);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <form className="flex min-h-0 flex-col" onSubmit={submit} aria-busy={busy || undefined}>
          <DialogHeader title={action === "check-in" ? `Check in ${name}` : `Check out ${name}`} description="Shift attendance only. The event check-in is separate." />
          <DialogBody className="flex flex-col gap-4">
            {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
            <Field label="Time" helperText={`In ${timeZone}. Leave it as now, or enter when it really happened.`}>
              <Input type="datetime-local" value={time} max={opened} onChange={(e) => setTime(e.target.value)} required />
            </Field>
            {earlier ? (
              <Field label="Reason for the earlier time" required helperText="Kept with the attendance record.">
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} required />
              </Field>
            ) : null}
            {action === "check-out" ? (
              <Field label="Break minutes" helperText="Subtracted from the time on duty.">
                <Input type="number" inputMode="numeric" min={0} max={720} value={breakMinutes} onChange={(e) => setBreakMinutes(e.target.value)} />
              </Field>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" type="submit" loading={busy}>{action === "check-in" ? "Check in" : "Check out"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
