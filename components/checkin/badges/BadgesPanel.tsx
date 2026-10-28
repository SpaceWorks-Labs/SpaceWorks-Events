"use client";

import { useMemo, useState } from "react";
import { getBadgeAttendeePhoto } from "@/app/actions/badge";
import { previewCheckInByRsvpId } from "@/app/actions/checkin";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/choice";
import { Callout, Chip, type ChipTone } from "@/components/ui/display";
import { Dropdown, Field, SearchInput } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { BADGE_STATUS_FILTER_LABELS, BADGE_STATUS_FILTERS, type BadgeStatusFilter } from "@/lib/badge/filters";
import { sheetLayout } from "@/lib/badge/sheet";
import type { BadgeBranding } from "@/lib/badge/types";
import { matchPaperPreset } from "@/lib/idCardPrint";
import { IdCardPrintDialog } from "../IdCardPrintDialog";
import { BadgeCanvas, BadgeFontFaces } from "../id-card/BadgeCanvas";
import { SaveStatusPill } from "../id-card/IdCardDesigner";
import { printCard } from "../id-card/printCards";
import { sampleAttendee, type BadgeDesignSeed, type BadgeDesignSource, type RegistrationField, useIdCardSettings } from "../id-card/shared";

export type BadgeListAttendee = { rsvpId: string; displayName: string; email: string | null; status: string; checkedIn: boolean; isCrew?: boolean };

const STATUS_PILLS: Record<string, { label: string; tone: ChipTone }> = {
  CONFIRMED: { label: "Confirmed", tone: "success" },
  WAITLISTED: { label: "Waitlisted", tone: "warning" },
  PENDING_APPROVAL: { label: "Pending approval", tone: "warning" },
};

const PAGE_SIZE = 50;

/** Fetch a download from a badge route and save it, surfacing the route's own error message. */
async function saveDownload(url: string, fallbackName: string) {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    let message = response.status === 404 ? "That badge isn't available any more. Refresh the page and try again." : "The download couldn't be prepared. Try again.";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the general message.
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 2000);
}

function matchesFilter(attendee: BadgeListAttendee, filter: BadgeStatusFilter) {
  if (filter === "checked-in") return attendee.checkedIn;
  if (filter === "not-checked-in") return attendee.status === "CONFIRMED" && !attendee.checkedIn;
  if (filter === "all") return true;
  if (filter === "crew") return attendee.isCrew === true;
  if (filter === "attendees") return attendee.status === "CONFIRMED" && !attendee.isCrew;
  return attendee.status === "CONFIRMED";
}

/**
 * The badges hub for an event: the saved design, a print-ready PDF of every
 * matching attendee, and each attendee's badge as PDF, PNG or a browser print.
 */
export function BadgesPanel({
  organisationSlug,
  organisationName,
  eventId,
  eventTitle,
  design,
  branding,
  registrationFields,
  attendees,
  totalAttendees,
  bulkLimit,
}: {
  organisationSlug: string;
  organisationName: string;
  eventId: string;
  eventTitle: string;
  design: BadgeDesignSeed;
  branding: BadgeBranding;
  registrationFields: RegistrationField[];
  attendees: BadgeListAttendee[];
  totalAttendees: number;
  bulkLimit: number;
}) {
  const source = useMemo<BadgeDesignSource>(() => ({ eventId, organisationSlug, eventTitle, organisationName, design, canSave: true }), [design, eventId, eventTitle, organisationName, organisationSlug]);
  const { settings, status } = useIdCardSettings(source);
  const [designerOpen, setDesignerOpen] = useState(false);
  const [filter, setFilter] = useState<BadgeStatusFilter>("confirmed");
  const [layout, setLayout] = useState<"card" | "a4">("card");
  const [bulk, setBulk] = useState<{ state: "idle" | "working" | "done" | "error"; message?: string }>({ state: "idle" });
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [busy, setBusy] = useState<{ rsvpId: string; action: string } | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const designReady = status === "saved" || status === "local" || status === "error";
  const base = `/api/exports/events/${encodeURIComponent(eventId)}/badges`;
  const counts = useMemo(() => Object.fromEntries(BADGE_STATUS_FILTERS.map((key) => [key, attendees.filter((attendee) => matchesFilter(attendee, key)).length])) as Record<BadgeStatusFilter, number>, [attendees]);
  const sheet = sheetLayout(settings.widthMm, settings.heightMm);
  const paper = matchPaperPreset(settings.widthMm, settings.heightMm);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? attendees.filter((attendee) => attendee.displayName.toLowerCase().includes(q) || attendee.email?.toLowerCase().includes(q)) : attendees;
  }, [attendees, query]);

  const downloadAll = async () => {
    setBulk({ state: "working" });
    try {
      await saveDownload(`${base}?format=pdf&status=${filter}&layout=${layout}`, "badges.pdf");
      setBulk({ state: "done", message: `Downloaded ${counts[filter]} badge${counts[filter] === 1 ? "" : "s"}.` });
    } catch (error) {
      setBulk({ state: "error", message: error instanceof Error ? error.message : "The download couldn't be prepared. Try again." });
    }
  };

  const rowAction = async (attendee: BadgeListAttendee, action: "pdf" | "png" | "print") => {
    setBusy({ rsvpId: attendee.rsvpId, action });
    setRowError(null);
    try {
      if (action === "print") {
        const preview = await previewCheckInByRsvpId({ organisationSlug, eventId, rsvpId: attendee.rsvpId, force: false });
        if (!preview.ok || !preview.data) throw new Error(preview.ok ? "That badge couldn't be prepared." : preview.error);
        let photoUrl: string | null = null;
        if (settings.showPhoto) {
          const photo = await getBadgeAttendeePhoto({ organisationSlug, eventId, rsvpId: attendee.rsvpId });
          photoUrl = photo.ok ? photo.data?.photoUrl ?? null : null;
        }
        const ok = await printCard({ settings, branding, attendee: { ...preview.data, photoUrl } });
        if (!ok) throw new Error("The print window was blocked. Allow pop-ups for this site and try again.");
      } else {
        await saveDownload(`${base}/${encodeURIComponent(attendee.rsvpId)}?format=${action}`, `badge.${action}`);
      }
    } catch (error) {
      setRowError(error instanceof Error ? `${attendee.displayName}: ${error.message}` : "The badge couldn't be prepared. Try again.");
    } finally {
      setBusy(null);
    }
  };

  // 260 px wide at most, so the preview and its padding fit a 375 px phone.
  const previewScale = Math.min(260 / settings.widthMm, 220 / settings.heightMm);

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <BadgeFontFaces />
      <section aria-labelledby="badge-attendees-title" className="order-2 flex min-w-0 flex-col gap-4 rounded-[16px] border border-line bg-panel p-4 sm:p-5 lg:order-none">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="badge-attendees-title" className="text-h4 text-ink">Attendees</h2>
            <p className="text-caption text-ink-muted tabular-nums">
              {totalAttendees > attendees.length ? `Showing the first ${attendees.length} of ${totalAttendees}.` : `${attendees.length} confirmed, waitlisted or pending.`}
            </p>
          </div>
          <div className="w-full sm:w-72">
            <label htmlFor="badge-search" className="sr-only">Search attendees by name or email</label>
            <SearchInput id="badge-search" placeholder="Name or email" value={query} onChange={(event) => { setQuery(event.target.value); setShown(PAGE_SIZE); }} />
          </div>
        </div>
        {!designReady ? <p className="text-caption text-ink-muted" role="status">Saving the design before downloads…</p> : null}
        {rowError ? <Callout tone="danger" role="alert" action={<Button size="sm" variant="quiet" onClick={() => setRowError(null)}>Dismiss</Button>}>{rowError}</Callout> : null}
        {attendees.length === 0 ? (
          <p className="text-body-ui text-ink-muted">No registrations yet. Badges appear here as people register.</p>
        ) : visible.length === 0 ? (
          <p className="text-body-ui text-ink-muted">No attendees match &ldquo;{query}&rdquo;. Try part of a name or email.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {visible.slice(0, shown).map((attendee) => {
              const pill = STATUS_PILLS[attendee.status] ?? { label: attendee.status, tone: "neutral" as ChipTone };
              const working = busy?.rsvpId === attendee.rsvpId;
              return (
                <li key={attendee.rsvpId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-ink">{attendee.displayName}</p>
                    {attendee.email ? <p className="truncate text-sm text-ink-muted">{attendee.email}</p> : null}
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Chip size="sm" tone={pill.tone}>{pill.label}</Chip>
                      {attendee.checkedIn ? <Chip size="sm" tone="success">Checked in</Chip> : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Badge for ${attendee.displayName}`}>
                    {(["pdf", "png", "print"] as const).map((action) => (
                      <Button
                        key={action}
                        size="sm"
                        variant={action === "print" ? "secondary" : "quiet"}
                        disabled={Boolean(busy) || !designReady}
                        aria-label={`${action === "print" ? "Print" : `Download ${action.toUpperCase()}`} badge for ${attendee.displayName}`}
                        onClick={() => rowAction(attendee, action)}
                      >
                        {working && busy?.action === action ? "Preparing…" : action === "print" ? "Print" : action.toUpperCase()}
                      </Button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {visible.length > shown ? (
          <Button variant="secondary" className="self-start" onClick={() => setShown((count) => count + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, visible.length - shown)} more
          </Button>
        ) : null}
      </section>

      <div className="order-1 flex flex-col gap-5 lg:order-none">
        <section aria-labelledby="badge-design-title" className="flex flex-col gap-4 rounded-[16px] border border-line bg-panel p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="badge-design-title" className="text-h4 text-ink">Design</h2>
              <p className="text-caption text-ink-muted tabular-nums">
                {paper ? paper.preset.label : `${settings.widthMm} × ${settings.heightMm} mm`} · {settings.colorMode === "mono" ? "black and white" : "colour"}
              </p>
            </div>
            <SaveStatusPill status={status} />
          </div>
          <div className="flex justify-center rounded-[16px] bg-subtle p-4">
            <BadgeCanvas settings={settings} attendee={sampleAttendee(registrationFields)} branding={branding} pxPerMm={previewScale} />
          </div>
          <Button variant="secondary" onClick={() => setDesignerOpen(true)}>Edit design</Button>
        </section>

        <section aria-labelledby="badge-bulk-title" className="flex flex-col gap-4 rounded-[16px] border border-line bg-panel p-4 sm:p-5">
          <div>
            <h2 id="badge-bulk-title" className="text-h4 text-ink">Download all</h2>
            <p className="text-caption text-ink-muted">One print-ready PDF, up to {bulkLimit} badges.</p>
          </div>
          <Field label="Attendees">
            <Dropdown value={filter} onChange={(event) => setFilter(event.target.value as BadgeStatusFilter)}>
              {BADGE_STATUS_FILTERS.map((key) => (
                <option key={key} value={key}>{BADGE_STATUS_FILTER_LABELS[key]} ({counts[key]})</option>
              ))}
            </Dropdown>
          </Field>
          <div className="flex flex-col gap-1.5">
            <p className="text-label text-ink">Layout</p>
            <SegmentedControl<"card" | "a4">
              ariaLabel="PDF layout"
              value={layout}
              onValueChange={setLayout}
              options={[{ value: "card", label: "One per page" }, { value: "a4", label: "A4 sheets" }]}
            />
            <p className="text-caption text-ink-muted">
              {layout === "card"
                ? "Each page is exactly one badge, for card and label printers."
                : `${sheet.perSheet} badge${sheet.perSheet === 1 ? "" : "s"} per A4 sheet (${sheet.columns} × ${sheet.rows}) with crop marks.`}
            </p>
          </div>
          <Button variant="primary" disabled={bulk.state === "working" || counts[filter] === 0 || !designReady} onClick={downloadAll}>
            {bulk.state === "working" ? "Preparing PDF…" : "Download all (PDF)"}
          </Button>
          {counts[filter] === 0 ? <p className="text-caption text-ink-muted">No attendees match this filter yet.</p> : null}
          {bulk.state === "working" ? (
            <p role="status" className="flex items-center gap-2 text-sm text-ink-secondary">
              <Spinner className="size-4" /> Preparing {counts[filter]} badge{counts[filter] === 1 ? "" : "s"}. Large events can take a minute.
            </p>
          ) : null}
          {bulk.state === "done" ? <Callout tone="success" role="status">{bulk.message}</Callout> : null}
          {bulk.state === "error" ? <Callout tone="danger" role="alert">{bulk.message}</Callout> : null}
        </section>
      </div>

      <IdCardPrintDialog
        open={designerOpen}
        onClose={() => setDesignerOpen(false)}
        source={source}
        branding={branding}
        attendee={null}
        registrationFields={registrationFields}
      />
    </div>
  );
}
