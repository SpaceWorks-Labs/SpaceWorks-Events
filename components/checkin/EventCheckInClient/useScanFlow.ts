"use client";

import { useCallback, type Dispatch, type SetStateAction, type TransitionStartFunction } from "react";
import type { RsvpStatus } from "@prisma/client";
import type { useRouter } from "next/navigation";
import { checkInByRsvpId, previewCheckInByToken, type CheckInPreviewData, type CheckInResultData, type LookupRow } from "@/app/actions/checkin";
import { gateCheckInForStatus, parseCheckInPayload } from "@/lib/checkIn";
import { getOfflineRoster, queueOfflineCheckIn, saveOfflineRoster, type OfflineAttendee, type OfflineRoster } from "@/lib/offline-checkin.client";
import type { useToast } from "@/components/feedback/ToastProvider";
import { playSuccessFeedback } from "@/components/checkin/checkInFeedback";
import type { LastResult, StationRequest } from "./types";

/** Scanning or pasting a ticket: preview it, then confirm the check-in online or into the offline queue. */
export function useScanFlow({
  organisationSlug,
  eventId,
  stationMode,
  override,
  idCardPrintingEnabled,
  idCardOpen,
  scanOpen,
  scanIsOffline,
  scanPreview,
  router,
  showToast,
  startTransition,
  stationRequest,
  showIdCard,
  refreshOfflineState,
  setLookupRows,
  setLastResult,
  setScanPreview,
  setScanIsOffline,
  setScanOpen,
  setManual,
}: {
  organisationSlug: string;
  eventId: string;
  stationMode: boolean;
  override: boolean;
  idCardPrintingEnabled: boolean;
  idCardOpen: boolean;
  scanOpen: boolean;
  scanIsOffline: boolean;
  scanPreview: CheckInPreviewData | null;
  router: ReturnType<typeof useRouter>;
  showToast: ReturnType<typeof useToast>["showToast"];
  startTransition: TransitionStartFunction;
  stationRequest: StationRequest;
  showIdCard: (attendee: CheckInResultData) => void;
  refreshOfflineState: () => Promise<void>;
  setLookupRows: Dispatch<SetStateAction<LookupRow[]>>;
  setLastResult: Dispatch<SetStateAction<LastResult>>;
  setScanPreview: Dispatch<SetStateAction<CheckInPreviewData | null>>;
  setScanIsOffline: Dispatch<SetStateAction<boolean>>;
  setScanOpen: Dispatch<SetStateAction<boolean>>;
  setManual: Dispatch<SetStateAction<string>>;
}) {
  const queueLocalCheckIn = useCallback(async (attendee: OfflineAttendee) => {
    const checkedInAt = new Date().toISOString();
    const roster = await getOfflineRoster(eventId);
    if (!roster) {
      showToast("No offline roster is available for this event.", "error");
      return;
    }
    const updatedRoster: OfflineRoster = {
      ...roster,
      rows: roster.rows.map((row) => row.rsvpId === attendee.rsvpId ? { ...row, checkedInAt } : row),
    };
    await saveOfflineRoster(updatedRoster);
    await queueOfflineCheckIn({ eventId, rsvpId: attendee.rsvpId, checkedInAt, force: override });
    setLookupRows((rows) => rows.map((row) => (row.rsvpId === attendee.rsvpId ? { ...row, checkedInAt } : row)));
    setLastResult({
      rsvpId: attendee.rsvpId,
      displayName: attendee.displayName,
      email: attendee.email,
      status: attendee.status,
      alreadyCheckedIn: false,
      checkedInAt,
      checkInQrToken: attendee.ticketToken,
      checkInDetails: attendee.checkInDetails ?? [],
      registrationDetails: attendee.registrationDetails ?? [],
      teamName: attendee.teamName ?? null,
      kind: "success",
    });
    if (idCardPrintingEnabled) showIdCard({
      rsvpId: attendee.rsvpId,
      displayName: attendee.displayName,
      email: attendee.email,
      status: attendee.status,
      alreadyCheckedIn: false,
      checkedInAt,
      checkInQrToken: attendee.ticketToken,
      checkInDetails: attendee.checkInDetails ?? [],
      registrationDetails: attendee.registrationDetails ?? [],
      teamName: attendee.teamName ?? null,
    });
    playSuccessFeedback();
    await refreshOfflineState();
    showToast(`Checked in offline: ${attendee.displayName}`, "success");
  }, [eventId, idCardPrintingEnabled, override, refreshOfflineState, showIdCard, showToast, setLastResult, setLookupRows]);

  const openPreviewForScan = useCallback(
    (text: string) => {
      if (!navigator.onLine && !stationMode) {
        void (async () => {
          const roster = await getOfflineRoster(eventId);
          if (!roster) {
            showToast("No offline roster is available. Connect once and select Make available offline.", "warning");
            return;
          }
          const token = parseCheckInPayload(text);
          const attendee = roster.rows.find((row) => row.ticketToken === token);
          if (!attendee) {
            showToast("This ticket is not in the offline roster.", "error");
            return;
          }
          const gate = gateCheckInForStatus(attendee.status as RsvpStatus, override);
          setScanPreview({
            rsvpId: attendee.rsvpId,
            displayName: attendee.displayName,
            email: attendee.email,
            status: attendee.status,
            alreadyCheckedIn: Boolean(attendee.checkedInAt),
            checkedInAt: attendee.checkedInAt,
            checkInQrToken: attendee.ticketToken,
            checkInDetails: attendee.checkInDetails ?? [],
            registrationDetails: attendee.registrationDetails ?? [],
            teamName: attendee.teamName ?? null,
            gate,
          });
          setScanIsOffline(true);
          setScanOpen(true);
        })();
        return;
      }
      startTransition(async () => {
        const res = stationMode
          ? await stationRequest("previewToken", { rawInput: text, force: override })
          : await previewCheckInByToken({ organisationSlug, eventId, rawInput: text, force: override });
        if (!res.ok) {
          showToast(res.error, "error");
          setScanPreview(null);
          setScanOpen(false);
          return;
        }
        setScanPreview(res.data!);
        setScanIsOffline(false);
        setScanOpen(true);
      });
    },
    [eventId, organisationSlug, override, showToast, stationMode, stationRequest, setScanIsOffline, setScanOpen, setScanPreview, startTransition],
  );

  const onScan = useCallback(
    (text: string) => {
      // Keep a scanned ticket from being replaced while staff confirm or print
      // the attendee currently at the desk.
      if (scanOpen || idCardOpen) return;
      openPreviewForScan(text);
    },
    [idCardOpen, openPreviewForScan, scanOpen],
  );

  const confirmScan = useCallback(() => {
    if (!scanPreview) return;
    if (scanIsOffline) {
      void (async () => {
        const roster = await getOfflineRoster(eventId);
        const attendee = roster?.rows.find((row) => row.rsvpId === scanPreview.rsvpId);
        if (!attendee) {
          showToast("This attendee is no longer in the offline roster.", "error");
          return;
        }
        if (attendee.checkedInAt) {
          setLastResult({ ...scanPreview, kind: "already" });
          showToast("Already checked in on this device", "info");
        } else {
          await queueLocalCheckIn(attendee);
        }
        setScanOpen(false);
        setScanPreview(null);
        setScanIsOffline(false);
        setManual("");
      })();
      return;
    }
    startTransition(async () => {
      const res = stationMode
        ? await stationRequest("checkInRsvp", { rsvpId: scanPreview.rsvpId, force: override })
        : await checkInByRsvpId({ organisationSlug, eventId, rsvpId: scanPreview.rsvpId, force: override });
      if (!res.ok) {
        if (res.needsForce) {
          showToast(`${res.error} Enable “Override” and try again.`, "warning");
        } else {
          showToast(res.error, "error");
        }
        return;
      }
      const d = res.data!;
      if (d.alreadyCheckedIn) {
        setLastResult({ ...d, kind: "already" });
        showToast("Already checked in", "info");
      } else {
        setLastResult({ ...d, kind: "success" });
        showToast(`Checked in: ${d.displayName}`, "success");
        playSuccessFeedback();
      }
      if (idCardPrintingEnabled) showIdCard(d);
      setLookupRows((rows) => rows.map((row) => (
        row.rsvpId === d.rsvpId
          ? { ...row, checkedInAt: d.checkedInAt }
          : row
      )));
      setScanOpen(false);
      setScanPreview(null);
      setManual("");
      router.refresh();
    });
  }, [eventId, idCardPrintingEnabled, organisationSlug, override, queueLocalCheckIn, router, scanIsOffline, scanPreview, showIdCard, showToast, stationMode, stationRequest, setLastResult, setLookupRows, setManual, setScanIsOffline, setScanOpen, setScanPreview, startTransition]);

  return { openPreviewForScan, onScan, confirmScan };
}
