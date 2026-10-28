"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { setVolunteerShifts } from "@/app/actions/volunteer-shifts";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/button";
import { SwitchRow } from "@/components/ui/choice";
import { Card, EmptyState } from "@/components/ui/display";
import type { DashboardShift, DashboardVolunteerShifts } from "@/lib/eventDashboard/volunteerShifts";
import { ContributorsCard } from "./ContributorsCard";
import { HoursCard } from "./HoursCard";
import { ShiftCard } from "./ShiftCard";
import { ShiftDialog } from "./ShiftDialog";

/**
 * Guests → Crew → Shifts (docs/VOLUNTEERS.md): the shift editor, roster and
 * approvals, attendance desk, hours verification and contributor
 * certificates. Any crew member may sign up from their crew ticket; their
 * crew kind never decides anything. Every change goes through
 * app/actions/volunteer-shifts.ts, which re-checks access.
 */
export function ShiftsPanel({ organisationSlug, eventId, data, now }: { organisationSlug: string; eventId: string; data: DashboardVolunteerShifts; now: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<DashboardShift | "new" | null>(null);

  function run(key: string, action: () => Promise<{ ok: boolean; error?: string }>, success?: string) {
    setBusyKey(key);
    startTransition(async () => {
      const result = await action();
      setBusyKey(null);
      if (!result.ok) {
        showToast(result.error ?? "That didn't work. Try again.", "error");
        return;
      }
      if (success) showToast(success, "success");
      router.refresh();
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" aria-busy={pending || undefined}>
      <Card>
        <SwitchRow
          label="Volunteer shifts"
          description="Crew see open shifts on their crew ticket, sign up, and check in and out of their own shifts. Shift attendance is separate from the event check-in."
          checked={data.enabled}
          disabled={pending}
          onCheckedChange={(enabled) => run("enabled", () => setVolunteerShifts({ organisationSlug, eventId, enabled }), enabled ? "Volunteer shifts are on" : "Volunteer shifts are off")}
        />
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-h4 text-ink">Shifts</h2>
          <p className="text-caption text-ink-muted">{data.shifts.length === 1 ? "1 shift" : `${data.shifts.length} shifts`}. Times in {data.timeZone}.</p>
        </div>
        <Button variant="primary" startIcon={<Plus />} onClick={() => setEditing("new")}>Add shift</Button>
      </div>

      {data.shifts.length === 0 ? (
        <EmptyState mood="sleepy" title="No shifts yet.">
          Add shifts with a time, a zone and a task. Crew sign up from their crew ticket, and you approve them here.
        </EmptyState>
      ) : (
        data.shifts.map((shift) => (
          <ShiftCard key={shift.id} organisationSlug={organisationSlug} eventId={eventId} timeZone={data.timeZone} shift={shift} now={now} busyKey={busyKey} run={run} onEdit={() => setEditing(shift)} />
        ))
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <HoursCard organisationSlug={organisationSlug} eventId={eventId} timeZone={data.timeZone} shifts={data.shifts} isAdmin={data.isAdmin} busyKey={busyKey} run={run} />
        <ContributorsCard organisationSlug={organisationSlug} eventId={eventId} data={data} busyKey={busyKey} run={run} />
      </div>

      {editing ? (
        <ShiftDialog
          organisationSlug={organisationSlug} eventId={eventId} timeZone={data.timeZone} shift={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => { setEditing(null); showToast(message, "success"); router.refresh(); }}
        />
      ) : null}
    </div>
  );
}
