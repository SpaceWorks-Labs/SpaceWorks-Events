"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import type { CheckInPreviewData, CheckInResultData, LookupRow } from "@/app/actions/checkin";
import { useToast } from "@/components/feedback/ToastProvider";
import { CheckInQrScanner } from "@/components/checkin/CheckInQrScanner";
import { IdCardPrintDialog } from "@/components/checkin/IdCardPrintDialog";
import type { BadgeDesignSource, BadgeDesignSeed } from "@/components/checkin/id-card/shared";
import type { BadgeBranding } from "@/lib/badge/types";
import { shouldRefreshCheckIn } from "@/lib/checkInRefresh";
import { CheckInHeader, DeskOptions, OfflinePanel } from "./EventCheckInClient/DeskPanels";
import { AttendeeDetailsDialog, ConfirmScanDialog } from "./EventCheckInClient/dialogs";
import { RecentCheckIns } from "./EventCheckInClient/RecentCheckIns";
import { AttendeeSearch, LastResultCard } from "./EventCheckInClient/ResultAndSearch";
import type { CheckInRecentRow, LastResult, StationResponse } from "./EventCheckInClient/types";
import { useLookupFlow } from "./EventCheckInClient/useLookupFlow";
import { useOfflineCheckIn } from "./EventCheckInClient/useOfflineCheckIn";
import { useRecentCheckIns } from "./EventCheckInClient/useRecentCheckIns";
import { useScanFlow } from "./EventCheckInClient/useScanFlow";

export type { CheckInRecentRow } from "./EventCheckInClient/types";

export function EventCheckInClient(props: {
  organisationSlug: string;
  organisationName: string;
  eventId: string;
  eventTitle: string;
  /** A PIN-authorised public station. It is deliberately online-only. */
  stationMode?: boolean;
  eventSlug?: string;
  registrationFields: Array<{ key: string; label: string }>;
  /** TEAM event: team names on badges ({{team}} and the Team line). */
  teamEvent?: boolean;
  stats: { confirmed: number; checkedIn: number };
  /** The newest page of check-ins (server-rendered on every refresh). */
  recent: CheckInRecentRow[];
  /** Cursor for the next, older page ("Load more"), or null when that was all. */
  recentNextCursor: string | null;
  /** The full attendee CSV, for operators allowed to export it; null hides the download. */
  attendeeExportHref: string | null;
  /** The event's saved badge design and artwork. Dashboard desks may edit it; stations only print it. */
  badge: { design: BadgeDesignSeed | null; branding: BadgeBranding; canSave: boolean };
}) {
  const { organisationSlug, organisationName, eventId, eventTitle, registrationFields, stats, recent, recentNextCursor, attendeeExportHref, stationMode = false, eventSlug, badge, teamEvent = false } = props;
  const badgeSource = useMemo<BadgeDesignSource>(() => ({
    eventId,
    organisationSlug,
    eventTitle,
    organisationName,
    design: badge.design,
    canSave: badge.canSave && !stationMode,
  }), [badge.canSave, badge.design, eventId, eventTitle, organisationName, organisationSlug, stationMode]);
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  const [manual, setManual] = useState("");
  const [override, setOverride] = useState(false);
  const [lastResult, setLastResult] = useState<LastResult>(null);
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupRows, setLookupRows] = useState<LookupRow[]>([]);
  const [scanPreview, setScanPreview] = useState<CheckInPreviewData | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanIsOffline, setScanIsOffline] = useState(false);
  const { offlineRoster, queuedCount, isOnline, refreshOfflineState, downloadOfflineRoster, syncOfflineQueue, clearOfflineRoster } = useOfflineCheckIn({ organisationSlug, eventId, stationMode, router, showToast, startTransition });
  const [idCardOpen, setIdCardOpen] = useState(false);
  const [idCardAttendee, setIdCardAttendee] = useState<CheckInResultData | null>(null);
  const [idCardPrintingEnabled, setIdCardPrintingEnabled] = useState(false);
  const [detailsAttendee, setDetailsAttendee] = useState<CheckInPreviewData | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const stationRequest = useCallback(async (action: string, payload: Record<string, unknown>): Promise<StationResponse> => {
    const response = await fetch("/api/check-in/station", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ organisationSlug, eventSlug, action, ...payload }) });
    const result = await response.json() as StationResponse;
    return result;
  }, [eventSlug, organisationSlug]);

  const showIdCard = useCallback((attendee: CheckInResultData) => {
    setIdCardAttendee(attendee);
    setIdCardOpen(true);
  }, []);

  useEffect(() => {
    const refreshWhenSafe = () => {
      if (shouldRefreshCheckIn({
        isVisible: document.visibilityState === "visible",
        isOnline,
        scanOpen,
        idCardOpen,
      })) {
        router.refresh();
      }
    };
    const interval = window.setInterval(refreshWhenSafe, 30_000);
    document.addEventListener("visibilitychange", refreshWhenSafe);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenSafe);
    };
  }, [idCardOpen, isOnline, router, scanOpen]);

  const { openPreviewForScan, onScan, confirmScan } = useScanFlow({
    organisationSlug, eventId, stationMode, override, idCardPrintingEnabled, idCardOpen, scanOpen, scanIsOffline, scanPreview, router, showToast, startTransition,
    stationRequest, showIdCard, refreshOfflineState, setLookupRows, setLastResult, setScanPreview, setScanIsOffline, setScanOpen, setManual,
  });

  useEffect(() => {
    if (!scanOpen) return;
    const t = window.setTimeout(() => {
      confirmRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [scanOpen]);

  const onManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    openPreviewForScan(manual);
  };

  const recentCheckIns = useRecentCheckIns({ organisationSlug, eventId, eventSlug, stationMode, recent, recentNextCursor, showToast });

  const { runLookup, checkInRow, viewAttendee, onUndo } = useLookupFlow({
    organisationSlug, eventId, stationMode, lookupQuery, router, showToast, startTransition,
    stationRequest, removeRecent: recentCheckIns.removeRecent, setLookupRows, setLastResult, setScanPreview, setScanIsOffline, setScanOpen, setDetailsAttendee,
  });

  const rate =
    stats.confirmed > 0
      ? Math.round((stats.checkedIn / stats.confirmed) * 1000) / 10
      : 0;

  const closeScan = () => {
    setScanOpen(false);
    setScanPreview(null);
  };

  return (
    <div className="flex flex-col gap-5">
      <CheckInHeader stationMode={stationMode} eventTitle={eventTitle} stats={stats} rate={rate} isOnline={isOnline} />

      {!stationMode ? (
        <OfflinePanel
          offlineRoster={offlineRoster}
          queuedCount={queuedCount}
          pending={pending}
          isOnline={isOnline}
          downloadOfflineRoster={downloadOfflineRoster}
          clearOfflineRoster={clearOfflineRoster}
          syncOfflineQueue={syncOfflineQueue}
        />
      ) : null}

      <DeskOptions
        override={override}
        setOverride={setOverride}
        idCardPrintingEnabled={idCardPrintingEnabled}
        setIdCardPrintingEnabled={setIdCardPrintingEnabled}
        setIdCardOpen={setIdCardOpen}
        setIdCardAttendee={setIdCardAttendee}
        badgeSource={badgeSource}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <section aria-labelledby="scan-title" className="flex flex-col gap-3">
            <div>
              <h2 id="scan-title" className="text-h4 text-ink">Scan QR</h2>
              <p className="text-sm text-ink-muted">Point the camera at an attendee ticket QR. Codes contain only a secret ticket link — no personal data in the barcode.</p>
            </div>
            <CheckInQrScanner onScan={onScan} disabled={pending} />
          </section>

          <section aria-labelledby="manual-title" className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
            <div>
              <h2 id="manual-title" className="text-title text-ink">Manual code</h2>
              <p className="text-sm text-ink-muted">Paste a ticket URL or the opaque code from the attendee&apos;s phone.</p>
            </div>
            <form onSubmit={onManualSubmit} className="flex flex-col gap-2.5">
              <label htmlFor="check-in-manual" className="sr-only">URL or code</label>
              <Textarea id="check-in-manual" rows={2} placeholder="URL or code" value={manual} onChange={(e) => setManual(e.target.value)} disabled={pending} />
              <Button type="submit" variant="primary" disabled={pending || !manual.trim()} className="self-start">
                Preview
              </Button>
            </form>
          </section>
        </div>

        <div className="flex flex-col gap-5">
          {lastResult ? (
            <LastResultCard lastResult={lastResult} setLastResult={setLastResult} idCardPrintingEnabled={idCardPrintingEnabled} showIdCard={showIdCard} />
          ) : null}

          <AttendeeSearch
            teamEvent={teamEvent}
            lookupQuery={lookupQuery}
            setLookupQuery={setLookupQuery}
            runLookup={runLookup}
            pending={pending}
            lookupRows={lookupRows}
            viewAttendee={viewAttendee}
            onUndo={onUndo}
            isOnline={isOnline}
            checkInRow={checkInRow}
            override={override}
          />
        </div>
      </div>

      <ConfirmScanDialog scanOpen={scanOpen} closeScan={closeScan} stationMode={stationMode} scanPreview={scanPreview} confirmScan={confirmScan} confirmRef={confirmRef} pending={pending} />

      <IdCardPrintDialog
        key={eventId}
        open={idCardOpen}
        onClose={() => setIdCardOpen(false)}
        source={badgeSource}
        branding={badge.branding}
        attendee={idCardAttendee ? {
          rsvpId: idCardAttendee.rsvpId,
          displayName: idCardAttendee.displayName,
          email: idCardAttendee.email,
          checkInQrToken: idCardAttendee.checkInQrToken,
          checkInDetails: idCardAttendee.checkInDetails,
          registrationDetails: idCardAttendee.registrationDetails,
          teamName: idCardAttendee.teamName ?? null,
          // Station responses carry the managed photo URL; dashboard desks look it up when needed.
          photoUrl: (idCardAttendee as { photoUrl?: string | null }).photoUrl,
        } : null}
        registrationFields={registrationFields}
        teamEvent={teamEvent}
      />

      <AttendeeDetailsDialog detailsAttendee={detailsAttendee} setDetailsAttendee={setDetailsAttendee} />

      <RecentCheckIns stationMode={stationMode} attendeeExportHref={attendeeExportHref} checkedIn={stats.checkedIn} recent={recentCheckIns} onUndo={onUndo} pending={pending} isOnline={isOnline} />

      {!stationMode ? (
        <p className="text-sm text-ink-muted">
          Each attendee has a unique ticket URL under <code className="font-mono text-[0.85em]">/ticket/&lt;code&gt;</code>. Use <strong>Copy ticket</strong> in the attendee list to share it, or open the check-in page from the event dashboard on a tablet at the door.
        </p>
      ) : null}
    </div>
  );
}
