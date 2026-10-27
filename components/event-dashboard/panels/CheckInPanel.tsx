import { loadCheckInListsSetup, loadCheckInPanel } from "@/lib/views/components__event-dashboard__panels__CheckInPanel";
import Link from "next/link";
import { Download, IdCard, ScanLine } from "lucide-react";
import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/display";
import { cn } from "@/lib/cn";
import { type DoorsTone } from "@/components/event-dashboard/check-in/doors";
import { DoorStationControls } from "@/components/event-dashboard/check-in/DoorStationControls";
import { CheckInListsCard } from "@/components/event-dashboard/check-in/CheckInListsCard";
import { NoPermission } from "./shared";

const DOORS_CHIP: Record<DoorsTone, string> = {
  upcoming: "bg-warning-bg text-warning-fg",
  live: "bg-success-bg text-success-fg",
  ended: "bg-muted text-ink-secondary",
  cancelled: "bg-danger-bg text-danger-fg",
};

const DOOR_RULES = [
  { dot: "bg-success-solid", title: "Going:", body: "scan and they are in." },
  { dot: "bg-warning-solid", title: "Waitlist:", body: "the desk asks before letting them in (Override)." },
  { dot: "bg-danger-solid", title: "Waiting for approval, declined, or a wrong ticket:", body: "blocked, with the reason shown." },
] as const;

const cardClass = "flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-panel p-5";

export async function CheckInPanel({ ctx }: { ctx: EventDashboardContext; }) {
  const { permissions } = ctx;
  if (!permissions.canCheckIn) {
    if (!permissions.canManageCheckInLists) return <NoPermission>You do not have permission to operate check-in.</NoPermission>;
    // EDIT_DETAILS co-organisers set up the lists; scanning stays with CHECK_IN.
    const { lists, addOns } = await loadCheckInListsSetup({ ctx });
    return (
      <div className="flex flex-col gap-5">
        <CheckInListsCard organisationSlug={ctx.organisation.slug} eventId={ctx.event.id} lists={lists} checkInHref={null} canManage addOns={addOns} />
        <NoPermission>Checking guests in needs the check-in permission.</NoPermission>
      </div>
    );
  }
  const { event, organisation, desk, lists, addOns, checkInHref, doors, seats, lit } = await loadCheckInPanel({ ctx });
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="checkin-desk-title" className="yy-dark-band flex flex-col gap-7 rounded-xl bg-[var(--yy-inverse-surface)] p-6 text-ink sm:p-7 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <span className={cn("inline-flex items-center gap-2 self-start rounded-full px-3 py-1 text-overline", DOORS_CHIP[doors.tone])}>
            {doors.tone === "live" ? <span aria-hidden className="size-2 rounded-full bg-success-solid" /> : null}
            {doors.label}
          </span>
          <h2 id="checkin-desk-title" className="font-display text-[30px] font-semibold leading-[1.05] tracking-[-0.02em] text-ink sm:text-[34px]">
            Check-in desk
          </h2>
          <p className="max-w-[560px] text-body-ui text-ink-secondary">
            Scan attendee QR codes from their ticket page, paste ticket URLs, or search by name. Works offline once the guest list is downloaded on that device.
          </p>
          <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
            <Button asChild variant="inverse" size="lg" className="whitespace-normal">
              <Link href={checkInHref}>
                <ScanLine aria-hidden className="size-5" />
                Open check-in
              </Link>
            </Button>
            <Button asChild variant="secondary" size="lg" className="whitespace-normal bg-transparent text-center">
              <Link href={checkInHref}>
                <Download aria-hidden className="size-5" />
                Download guest list for offline
              </Link>
            </Button>
          </div>
        </div>
        <div className="flex w-full flex-col gap-3 lg:max-w-[320px]">
          <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="font-display text-[48px] font-semibold leading-none text-ink">{desk.checkedIn}</span>
            <span className="text-[17px] font-semibold text-ink-secondary">of {desk.confirmed} checked in</span>
          </p>
          <div aria-hidden className="grid w-full max-w-[340px] grid-cols-12 gap-1.5">
            {Array.from({ length: seats }, (_, index) => (
              <span key={index} className={cn("aspect-square rounded-full", index < lit ? "bg-brand-marigold" : "bg-brand-dot-off")} />
            ))}
          </div>
        </div>
      </section>

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        <section aria-labelledby="checkin-station-title" className={cardClass}>
          <div className="flex items-center justify-between gap-3">
            <h2 id="checkin-station-title" className="text-h4 text-ink">Door station</h2>
            <Chip size="sm" tone={desk.stationEnabled ? "success" : "neutral"}>{desk.stationEnabled ? "On" : "Off"}</Chip>
          </div>
          <p className="text-sm text-ink-secondary">
            Volunteers without an account open the station link on a phone or tablet and enter the PIN. It permits online check-in only; roster and CSV exports stay in this dashboard.
          </p>
          {desk.canManageStation ? (
            <DoorStationControls organisationSlug={organisation.slug} eventId={event.id} stationUrl={desk.stationUrl} enabled={desk.stationEnabled} />
          ) : (
            <p className="text-sm text-ink-muted">Only organisation admins can turn the station on, show its PIN, or change it.</p>
          )}
        </section>

        <section aria-labelledby="checkin-rules-title" className={cardClass}>
          <h2 id="checkin-rules-title" className="text-h4 text-ink">At the door</h2>
          <ul className="flex flex-col gap-2.5">
            {DOOR_RULES.map((rule) => (
              <li key={rule.title} className="flex gap-2.5 text-sm text-ink">
                <span aria-hidden className={cn("mt-[7px] size-2 shrink-0 rounded-full", rule.dot)} />
                <span>
                  <strong className="font-semibold">{rule.title}</strong> {rule.body}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <CheckInListsCard organisationSlug={organisation.slug} eventId={event.id} lists={lists} checkInHref={checkInHref} canManage={permissions.canManageCheckInLists} addOns={addOns} className="md:col-span-2 xl:col-span-3" />

        <section aria-labelledby="checkin-attendance-title" className={cn(cardClass, "md:col-span-2 xl:col-span-1")}>
          <h2 id="checkin-attendance-title" className="text-h4 text-ink">Attendance</h2>
          <p className="text-sm text-ink-secondary">
            Download who registered and who arrived, with check-in times. Print a name badge for any attendee from the check-in page.
          </p>
          <div className="flex flex-wrap gap-2">
            {desk.canExportAttendance ? (
              <Button asChild size="sm" variant="secondary">
                <a href={`/api/exports/events/${event.id}/attendees`}>
                  <Download aria-hidden className="size-4" />
                  Export attendance
                </a>
              </Button>
            ) : null}
            <Button asChild size="sm" variant="secondary">
              <Link href={checkInHref}>
                <IdCard aria-hidden className="size-4" />
                Print ID cards
              </Link>
            </Button>
          </div>
          {!desk.canExportAttendance ? <p className="text-caption text-ink-muted">Ask an organisation admin for the full attendance export.</p> : null}
        </section>
      </div>
    </div>
  );
}
