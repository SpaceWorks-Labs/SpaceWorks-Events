"use client";

import { useEffect, useState } from "react";
import { Description as DialogDescription } from "@radix-ui/react-dialog";
import { getBadgeAttendeePhoto } from "@/app/actions/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { BadgeBranding } from "@/lib/badge/types";
import { IdCardDesigner } from "./id-card/IdCardDesigner";
import { QuickPrintSheet } from "./id-card/QuickPrintSheet";
import { type BadgeDesignSource, type IdCardAttendee, type RegistrationField, useIdCardSettings } from "./id-card/shared";

/**
 * Badge printing at the check-in desk. With an attendee it opens the quick
 * print sheet (their badge plus one Print button); without one, or after
 * "Edit design", it opens the full designer (dashboard desks only).
 */
export function IdCardPrintDialog(props: {
  open: boolean;
  onClose: () => void;
  source: BadgeDesignSource;
  branding: BadgeBranding;
  attendee: IdCardAttendee | null;
  registrationFields: RegistrationField[];
  /** TEAM event: the designer offers the Team line and the {{team}} merge field. */
  teamEvent?: boolean;
}) {
  const { open, onClose, attendee, source } = props;
  const { settings } = useIdCardSettings(source);
  const [designing, setDesigning] = useState(false);
  // Reset to the quick sheet whenever the dialog opens for someone new.
  // (The check-in page passes a fresh object each render, so compare the ticket.)
  const attendeeKey = attendee?.checkInQrToken ?? null;
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ key: string; url: string | null } | null>(null);
  if (open && attendeeKey !== openedFor) {
    setOpenedFor(attendeeKey);
    setDesigning(false);
  }

  // Dashboard check-in results don't carry the photo; look it up only when the design shows one.
  const rsvpId = attendee?.rsvpId;
  const needsPhoto = open && settings.showPhoto && source.canSave && Boolean(rsvpId) && attendee?.photoUrl === undefined;
  useEffect(() => {
    if (!needsPhoto || !rsvpId || !attendeeKey) return;
    let cancelled = false;
    void getBadgeAttendeePhoto({ organisationSlug: source.organisationSlug, eventId: source.eventId, rsvpId })
      .then((result) => {
        if (!cancelled) setPhoto({ key: attendeeKey, url: result.ok ? result.data?.photoUrl ?? null : null });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [attendeeKey, needsPhoto, rsvpId, source.eventId, source.organisationSlug]);

  const person = attendee && photo?.key === attendeeKey && attendee.photoUrl === undefined ? { ...attendee, photoUrl: photo.url } : attendee;
  const showDesigner = source.canSave && (!person || designing);
  const close = () => {
    setDesigning(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent
        size={showDesigner ? "xl" : "md"}
        hideClose={showDesigner}
        aria-labelledby="id-card-designer-title"
        className={showDesigner ? "h-[min(940px,96dvh)] max-h-[96dvh] w-[calc(100vw-16px)] max-w-330 sm:w-[calc(100vw-32px)]" : undefined}
      >
        <DialogDescription className="sr-only">
          {showDesigner ? "Design the badge printed at check-in." : "Print this attendee's badge."}
        </DialogDescription>
        {showDesigner ? (
          <IdCardDesigner
            source={source}
            branding={props.branding}
            attendee={person}
            registrationFields={props.registrationFields}
            teamEvent={props.teamEvent}
            onClose={person ? () => setDesigning(false) : close}
          />
        ) : person ? (
          <QuickPrintSheet
            source={source}
            branding={props.branding}
            attendee={person}
            onEditDesign={source.canSave ? () => setDesigning(true) : null}
            onClose={close}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
