"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { myShiftAction } from "@/app/actions/my-shifts";
import { Button } from "@/components/ui/button";
import { Callout, Chip, type ChipTone } from "@/components/ui/display";
import { formatDayShort, formatTime, formatTimeRange } from "@/lib/format/datetime";
import { formatDuration } from "@/lib/volunteer/math";
import type { MyShift, MyShiftsView } from "@/lib/volunteer/ticketView";

const STATUS: Record<string, { label: string; tone: ChipTone }> = {
  APPLIED: { label: "Waiting for approval", tone: "info" },
  WAITLISTED: { label: "On the waitlist", tone: "warning" },
  APPROVED: { label: "You have a place", tone: "success" },
  WITHDRAWN: { label: "Withdrawn", tone: "outline" },
  DECLINED: { label: "Not this time", tone: "outline" },
};

/**
 * "My shifts" on a crew ticket (docs/VOLUNTEERS.md): open shifts to sign up
 * for, your own sign-ups, check-in and check-out of your own shifts, your
 * verified hours and your certificate. The server re-checks everything.
 */
export function MyShifts({ ticketToken, view }: { ticketToken: string; view: MyShiftsView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  function act(action: "apply" | "withdraw" | "check-in" | "check-out", id: string, success: string) {
    setBusy(id);
    setMessage(null);
    startTransition(async () => {
      const result = await myShiftAction({ ticketToken, action, id });
      setBusy(null);
      if (!result.ok) {
        setMessage({ tone: "danger", text: result.error });
        return;
      }
      const status = result.data?.status;
      setMessage({ tone: "success", text: status === "WAITLISTED" ? "The shift is full, so you're on the waitlist. You'll get an email if a place opens up." : status === "APPLIED" ? "Signed up. The organisers will confirm your place." : success });
      router.refresh();
    });
  }

  const mine = view.shifts.filter((shift) => shift.signup && shift.signup.status !== "WITHDRAWN");
  const open = view.shifts.filter((shift) => shift.open && (!shift.signup || shift.signup.status === "WITHDRAWN"));

  return (
    <section aria-labelledby="my-shifts" aria-busy={pending || undefined} className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-4">
      <div>
        <h2 id="my-shifts" className="text-h4 text-ink">My shifts</h2>
        <p className="text-body-ui text-ink-secondary">
          {view.verifiedMinutes > 0 ? `${formatDuration(view.verifiedMinutes)} of your time is verified. Thank you!` : "Sign up for shifts, and check in and out here when you're on duty."}
        </p>
      </div>
      {message ? <Callout tone={message.tone} role={message.tone === "danger" ? "alert" : "status"}>{message.text}</Callout> : null}
      {view.certificatePath ? (
        <Button asChild variant="secondary" startIcon={<Download aria-hidden />}>
          <a href={view.certificatePath} download>Download your certificate</a>
        </Button>
      ) : null}

      {mine.length > 0 ? (
        <ul aria-label="Your shifts" className="flex flex-col divide-y divide-line">
          {mine.map((shift) => <MineRow key={shift.id} shift={shift} timeZone={view.timeZone} busy={busy} disabled={pending} act={act} />)}
        </ul>
      ) : null}

      {open.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-label text-ink">Open shifts</h3>
          <ul aria-label="Open shifts" className="flex flex-col divide-y divide-line">
            {open.map((shift) => (
              <li key={shift.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <ShiftText shift={shift} timeZone={view.timeZone} extra={shift.placesLeft === 0 ? "Full: waitlist" : shift.placesLeft != null ? `${shift.placesLeft} ${shift.placesLeft === 1 ? "place" : "places"} left` : undefined} />
                <Button size="sm" variant="primary" loading={busy === shift.id} disabled={pending} onClick={() => act("apply", shift.id, "You have a place on this shift.")}>Sign up</Button>
              </li>
            ))}
          </ul>
        </div>
      ) : mine.length === 0 ? (
        <p className="text-body-ui text-ink-muted">No open shifts right now.</p>
      ) : null}
    </section>
  );
}

function ShiftText({ shift, timeZone, extra }: { shift: MyShift; timeZone: string; extra?: string }) {
  const start = new Date(shift.startsAt);
  return (
    <div className="min-w-0 flex-[1_1_200px]">
      <p className="text-body-ui font-semibold text-ink">{shift.title}</p>
      <p className="text-caption text-ink-muted">
        {formatDayShort(start, timeZone)} · {formatTimeRange(start, new Date(shift.endsAt), timeZone, { withZone: true })}
        {shift.zone ? ` · ${shift.zone}` : ""}{shift.task ? ` · ${shift.task}` : ""}{extra ? ` · ${extra}` : ""}
      </p>
    </div>
  );
}

function MineRow({ shift, timeZone, busy, disabled, act }: { shift: MyShift; timeZone: string; busy: string | null; disabled: boolean; act: (action: "withdraw" | "check-in" | "check-out", id: string, success: string) => void }) {
  const signup = shift.signup!;
  const status = STATUS[signup.status];
  const canCheckIn = signup.status === "APPROVED" && signup.attendance === "SCHEDULED" && shift.checkInOpen;
  const working = signup.attendance === "CHECKED_IN";
  const hours = signup.minutes != null ? `${formatDuration(signup.minutes)} ${signup.hoursState === "PENDING" ? "waiting for verification" : "verified"}` : undefined;
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <ShiftText shift={shift} timeZone={timeZone} extra={working && signup.checkedInAt ? `on duty since ${formatTime(new Date(signup.checkedInAt), timeZone)}` : hours} />
      <div className="flex flex-wrap items-center gap-1.5">
        {signup.attendance === "NO_SHOW" ? <Chip size="sm" tone="danger">Marked absent</Chip> : signup.attendance === "SCHEDULED" && status ? <Chip size="sm" tone={status.tone}>{status.label}</Chip> : null}
        {canCheckIn ? <Button size="sm" variant="primary" loading={busy === signup.id} disabled={disabled} onClick={() => act("check-in", signup.id, "You're checked in. Check out when you finish.")}>Check in</Button> : null}
        {working ? <Button size="sm" variant="primary" loading={busy === signup.id} disabled={disabled} onClick={() => act("check-out", signup.id, "You're checked out. The organisers will verify your hours.")}>Check out</Button> : null}
        {signup.attendance === "SCHEDULED" && ["APPLIED", "WAITLISTED", "APPROVED"].includes(signup.status) ? (
          <Button size="sm" variant="quiet" disabled={disabled} onClick={() => act("withdraw", signup.id, "You've withdrawn from this shift.")}>Withdraw</Button>
        ) : null}
      </div>
    </li>
  );
}
