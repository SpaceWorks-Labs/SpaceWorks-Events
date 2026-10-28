"use client";

import { useCallback, type Dispatch, type SetStateAction, type TransitionStartFunction } from "react";
import type { RsvpStatus } from "@prisma/client";
import type { useRouter } from "next/navigation";
import { lookupAttendeesForCheckIn, previewCheckInByRsvpId, undoCheckIn, type CheckInPreviewData, type LookupRow } from "@/app/actions/checkin";
import { gateCheckInForStatus } from "@/lib/checkIn";
import { getOfflineRoster } from "@/lib/offline-checkin.client";
import type { useToast } from "@/components/feedback/ToastProvider";
import type { LastResult, StationRequest } from "./types";

/** Searching attendees by name or email, and checking in, viewing or undoing a result. */
export function useLookupFlow({
  organisationSlug,
  eventId,
  stationMode,
  lookupQuery,
  router,
  showToast,
  startTransition,
  stationRequest,
  removeRecent,
  setLookupRows,
  setLastResult,
  setScanPreview,
  setScanIsOffline,
  setScanOpen,
  setDetailsAttendee,
}: {
  organisationSlug: string;
  eventId: string;
  stationMode: boolean;
  lookupQuery: string;
  router: ReturnType<typeof useRouter>;
  showToast: ReturnType<typeof useToast>["showToast"];
  startTransition: TransitionStartFunction;
  stationRequest: StationRequest;
  /** Drops an undone check-in from Recent check-ins, including older loaded pages. */
  removeRecent: (rsvpId: string) => void;
  setLookupRows: Dispatch<SetStateAction<LookupRow[]>>;
  setLastResult: Dispatch<SetStateAction<LastResult>>;
  setScanPreview: Dispatch<SetStateAction<CheckInPreviewData | null>>;
  setScanIsOffline: Dispatch<SetStateAction<boolean>>;
  setScanOpen: Dispatch<SetStateAction<boolean>>;
  setDetailsAttendee: Dispatch<SetStateAction<CheckInPreviewData | null>>;
}) {
  const runLookup = useCallback(() => {
    // The server needs two characters; answer shorter searches here instead of with "Invalid input".
    if (lookupQuery.trim().length < 2) {
      setLookupRows([]);
      showToast("Type at least two letters of a name or email.", "info");
      return;
    }
    if (!navigator.onLine && !stationMode) {
      void (async () => {
        const q = lookupQuery.trim().toLowerCase();
        const roster = await getOfflineRoster(eventId);
        if (!roster) {
          showToast("No offline roster is available for this event.", "warning");
          return;
        }
        setLookupRows(
          q.length < 2
            ? []
            : roster.rows
                .filter((row) => row.displayName.toLowerCase().includes(q) || row.email?.toLowerCase().includes(q) || row.teamName?.toLowerCase().includes(q))
                .slice(0, 12)
                .map(({ rsvpId, displayName, email, status, checkedInAt, teamName, attendance }) => ({ rsvpId, displayName, email, status, checkedInAt, teamName, attendance })),
        );
      })();
      return;
    }
    startTransition(async () => {
      const res = stationMode
        ? await stationRequest("lookup", { query: lookupQuery })
        : await lookupAttendeesForCheckIn({ organisationSlug, eventId, query: lookupQuery });
      if (!res.ok) {
        showToast(res.error, "error");
        return;
      }
      setLookupRows(res.data!.rows);
    });
  }, [eventId, lookupQuery, organisationSlug, showToast, stationMode, stationRequest, setLookupRows, startTransition]);

  const checkInRow = (row: LookupRow, force: boolean) => {
    if (!navigator.onLine && !stationMode) {
      void (async () => {
        const roster = await getOfflineRoster(eventId);
        const attendee = roster?.rows.find((item) => item.rsvpId === row.rsvpId);
        if (!attendee) {
          showToast("This attendee is not available in the offline roster.", "error");
          return;
        }
        const gate = gateCheckInForStatus(attendee.status as RsvpStatus, force);
        if (!gate.ok) {
          showToast(gate.reason, "warning");
          return;
        }
        if (attendee.checkedInAt) {
          showToast(`${attendee.displayName} was already checked in.`, "info");
          return;
        }
        setScanPreview({
          rsvpId: attendee.rsvpId,
          displayName: attendee.displayName,
          email: attendee.email,
          status: attendee.status,
          alreadyCheckedIn: false,
          checkedInAt: null,
          checkInQrToken: attendee.ticketToken,
          checkInDetails: attendee.checkInDetails ?? [],
          registrationDetails: attendee.registrationDetails ?? [],
          teamName: attendee.teamName ?? null,
          attendance: attendee.attendance ?? null,
          gate,
        });
        setScanIsOffline(true);
        setScanOpen(true);
      })();
      return;
    }
    startTransition(async () => {
      const res = stationMode
        ? await stationRequest("previewRsvp", { rsvpId: row.rsvpId, force })
        : await previewCheckInByRsvpId({ organisationSlug, eventId, rsvpId: row.rsvpId, force });
      if (!res.ok) {
        if (res.needsForce) {
          showToast(`${res.error} Enable “Override” and try again.`, "warning");
        } else {
          showToast(res.error, "error");
        }
        return;
      }
      setScanPreview(res.data!);
      setScanIsOffline(false);
      setScanOpen(true);
    });
  };

  const viewAttendee = (row: LookupRow) => {
    startTransition(async () => {
      const res = stationMode
        ? await stationRequest("previewRsvp", { rsvpId: row.rsvpId, force: false })
        : await previewCheckInByRsvpId({ organisationSlug, eventId, rsvpId: row.rsvpId, force: false });
      if (!res.ok) return showToast(res.error, "error");
      setDetailsAttendee(res.data!);
    });
  };

  const onUndo = (rsvpId: string) => {
    startTransition(async () => {
      const res = stationMode ? await stationRequest("undo", { rsvpId }) : await undoCheckIn({ organisationSlug, eventId, rsvpId });
      if (!res.ok) {
        showToast(res.error, "error");
        return;
      }
      removeRecent(rsvpId);
      showToast("Check-in removed", "success");
      // Search results and the result card would otherwise still say "Checked in" and offer Undo again.
      setLookupRows((rows) => rows.map((row) => (row.rsvpId === rsvpId ? { ...row, checkedInAt: null } : row)));
      setLastResult((result) => (result?.rsvpId === rsvpId ? null : result));
      router.refresh();
    });
  };

  return { runLookup, checkInRow, viewAttendee, onUndo };
}
