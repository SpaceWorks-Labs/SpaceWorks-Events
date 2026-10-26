"use client";

import { useState } from "react";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Dropdown, Field } from "@/components/ui/field";

/**
 * The saved design rendered on the server exactly as tickets will be
 * (docs/TICKET_DESIGNER.md), with sample values or, for an event's design, a
 * real registration's. The preview's QR is a sample, never a live ticket.
 */
export function PreviewDialog({ designId, organisationSlug, version, attendees, onClose }: {
  designId: string;
  organisationSlug: string;
  /** Changes whenever the design is saved, so the image reloads. */
  version: string;
  attendees: Array<{ id: string; label: string; }>;
  onClose: () => void;
}) {
  const [rsvp, setRsvp] = useState("");
  const src = `/api/ticket-designs/${designId}/preview?org=${encodeURIComponent(organisationSlug)}${rsvp ? `&rsvp=${encodeURIComponent(rsvp)}` : ""}&v=${encodeURIComponent(version)}`;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="lg">
        <DialogHeader title="Preview" description="Exactly as the ticket will be drawn. The QR code here is a sample." />
        <DialogBody className="flex flex-col gap-4 pb-6">
          {attendees.length > 0 ? (
            <Field label="Show as">
              <Dropdown value={rsvp} onChange={(event) => setRsvp(event.target.value)}>
                <option value="">Sample attendee</option>
                {attendees.map((attendee) => <option key={attendee.id} value={attendee.id}>{attendee.label}</option>)}
              </Dropdown>
            </Field>
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element -- a private, uncached server render */}
          <img src={src} alt="Ticket preview" className="h-auto w-full rounded-lg border border-line" />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
