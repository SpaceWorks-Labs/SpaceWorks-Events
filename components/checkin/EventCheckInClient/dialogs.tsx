"use client";

import { Users } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { CheckInPreviewData } from "@/app/actions/checkin";
import { Button } from "@/components/ui/button";
import { Callout, Chip } from "@/components/ui/display";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { CheckInDetailsList, CheckInTimestamp, CrewChip, RegistrationDetailsList, StatusChip } from "./parts";
import { AttendanceChip } from "@/components/attendance/AttendanceChip";

/** Confirms a scanned or searched attendee before checking them in; Enter confirms. */
export function ConfirmScanDialog({
  scanOpen,
  closeScan,
  stationMode,
  scanPreview,
  confirmScan,
  confirmRef,
  pending,
}: {
  scanOpen: boolean;
  closeScan: () => void;
  stationMode: boolean;
  scanPreview: CheckInPreviewData | null;
  confirmScan: () => void;
  confirmRef: RefObject<HTMLButtonElement | null>;
  pending: boolean;
}) {
  return (
    <Dialog open={scanOpen} onOpenChange={(next) => { if (!next) closeScan(); }}>
      <DialogContent
        size="sm"
        hideClose={stationMode}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (scanPreview?.gate.ok) confirmScan();
          }
        }}
      >
        <DialogHeader title="Confirm check-in" />
        <DialogBody className="flex flex-col gap-2">
          {scanPreview ? (
            <>
              <p className="font-display text-[24px] font-semibold leading-tight text-ink">{scanPreview.displayName}</p>
              <p className="text-sm text-ink-muted">{scanPreview.email ?? "—"}</p>
              {scanPreview.teamName ? <p className="flex items-center gap-1.5 text-sm font-semibold text-ink"><Users aria-hidden className="size-4 shrink-0" />Team: {scanPreview.teamName}</p> : null}
              <div className="flex flex-wrap gap-1.5 pt-1">
                <StatusChip status={scanPreview.status} />
                <CrewChip data={scanPreview} />
                <AttendanceChip state={scanPreview.attendance} />
                {scanPreview.alreadyCheckedIn ? <Chip size="sm" tone="neutral">Already checked in</Chip> : null}
              </div>
              {!scanPreview.gate.ok ? <Callout tone={scanPreview.gate.blocked ? "danger" : "warning"}>{scanPreview.gate.reason}</Callout> : null}
              <div className="text-ink"><CheckInDetailsList details={scanPreview.checkInDetails} /></div>
              {scanPreview.gate.ok ? <p className="text-caption text-ink-muted">Press Enter to confirm.</p> : null}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {/* Stations are touch tablets: a blocked registration needs a visible way out, not only Esc. */}
          <Button variant="secondary" onClick={closeScan}>Cancel</Button>
          <Button
            ref={(el) => {
              confirmRef.current = el;
            }}
            variant="primary"
            onClick={confirmScan}
            disabled={!scanPreview?.gate.ok || pending}
            autoFocus
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One attendee's status, check-in time and details, opened from search results. */
export function AttendeeDetailsDialog({
  detailsAttendee,
  setDetailsAttendee,
}: {
  detailsAttendee: CheckInPreviewData | null;
  setDetailsAttendee: Dispatch<SetStateAction<CheckInPreviewData | null>>;
}) {
  return (
    <Dialog open={Boolean(detailsAttendee)} onOpenChange={(next) => { if (!next) setDetailsAttendee(null); }}>
      <DialogContent size="sm">
        <DialogHeader title="Attendee details" />
        <DialogBody className="flex flex-col gap-2.5 text-ink">
          {detailsAttendee ? (
            <>
              <p className="text-[19px] font-bold">{detailsAttendee.displayName}</p>
              <p className="text-sm text-ink-muted">{detailsAttendee.email ?? "No email address"}</p>
              {detailsAttendee.teamName ? <p className="text-sm">Team: <span className="font-semibold">{detailsAttendee.teamName}</span></p> : null}
              <div className="flex flex-wrap gap-1.5">
                <StatusChip status={detailsAttendee.status} />
                <CrewChip data={detailsAttendee} />
                <AttendanceChip state={detailsAttendee.attendance} />
                {detailsAttendee.alreadyCheckedIn ? <Chip size="sm" tone="success">Already checked in</Chip> : null}
              </div>
              {detailsAttendee.checkedInAt ? <p className="text-sm">Checked in: <CheckInTimestamp value={detailsAttendee.checkedInAt} /></p> : null}
              {detailsAttendee.checkInDetails.length > 0 ? <div><p className="text-label">Check-in details</p><CheckInDetailsList details={detailsAttendee.checkInDetails} /></div> : null}
              {detailsAttendee.registrationDetails.length > 0 ? <div><p className="text-label">Registration details</p><RegistrationDetailsList details={detailsAttendee.registrationDetails} /></div> : null}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setDetailsAttendee(null)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
