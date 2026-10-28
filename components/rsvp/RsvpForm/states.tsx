"use client";

import Link from "next/link";
import type { RsvpStatus } from "@prisma/client";
import { CheckCircle2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";

export function FramedCheckoutNotice({ framedCheckout }: { framedCheckout: { checkoutUrl: string; orderToken: string | null } }) {
  return (
    <div role="status" className="flex flex-col items-start gap-3 rounded-lg bg-info-bg p-5 text-ink">
      <p className="text-body font-semibold">Your tickets are held. Pay on the secure payment page, which opens in a new tab.</p>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="accent" size="sm">
          <a href={framedCheckout.checkoutUrl} target="_blank" rel="noopener noreferrer">Open the payment page</a>
        </Button>
        {framedCheckout.orderToken ? (
          <Button asChild variant="secondary" size="sm">
            <a href={`/order/${framedCheckout.orderToken}`} target="_blank" rel="noopener noreferrer">View your order</a>
          </Button>
        ) : null}
      </div>
      <p className="text-caption text-ink-muted">Finish paying in the new tab; your order page confirms the tickets.</p>
    </div>
  );
}

export function RsvpDone({ ticketToken, rsvpStatus, sellsPaid, registeredAs = null, joinTeamName = null }: { ticketToken: string; rsvpStatus: RsvpStatus | null; sellsPaid: boolean; registeredAs?: "create" | "join" | "solo" | null; joinTeamName?: string | null }) {
  const href = ticketToken ? `/ticket/${ticketToken}` : null;
  const ticketDownloadUrl = ticketToken ? `/api/ticket/${ticketToken}/download` : null;
  const isConfirmed = rsvpStatus === "CONFIRMED";
  return (
    <div role="status" className="flex flex-col items-start gap-3 rounded-lg bg-success-bg p-5 text-success-fg">
      <CheckCircle2 aria-hidden className="yy-success-in size-8" />
      <p className="text-body font-semibold">
        {isConfirmed
          ? "Registration confirmed. Download and save your ticket now — you’ll need it for check-in."
          : sellsPaid && (rsvpStatus === "PENDING_APPROVAL" || rsvpStatus === "WAITLISTED")
            ? rsvpStatus === "WAITLISTED"
              ? "You’re on the waitlist. Nothing has been charged; if a place frees up, we’ll email you a link to pay."
              : "Request sent. Nothing has been charged; if the organiser approves it, we’ll email you a link to pay."
            : "Registration received. We’ll let you know when its status changes."}
      </p>
      {registeredAs === "create" ? (
        <p className="text-body-ui">
          Your team is registered. Check your email for your team page link, where you manage the team, and the join link to share with your teammates.
        </p>
      ) : registeredAs === "join" && joinTeamName ? (
        <p className="text-body-ui">You’re on {joinTeamName}. Your registration follows the team’s status.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {isConfirmed && ticketDownloadUrl ? (
          <Button asChild variant="primary" size="sm">
            <a href={ticketDownloadUrl} download>
              <Download aria-hidden className="size-4" />
              Download and save ticket
            </a>
          </Button>
        ) : null}
        {href ? (
          <Button asChild variant="secondary" size="sm">
            <Link href={href}>{isConfirmed ? "View ticket" : "View status"}</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
