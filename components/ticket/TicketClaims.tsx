"use client";

import { Undo2 } from "lucide-react";
import { withdrawParticipantClaimAction } from "@/app/actions/participant-claims";
import { Button } from "@/components/ui/button";
import { Callout, Chip } from "@/components/ui/display";
import { ClaimForm } from "@/components/event-dashboard/finance/ClaimForm";
import { CLAIM_STATUS, useSave } from "@/components/event-dashboard/finance/shared";
import type { TicketClaimsView } from "@/lib/claims/ticketView";

/** "Claim expenses" on a confirmed participant's ticket page (docs/FINANCE.md). */
export function TicketClaims({ ticketToken, view }: { ticketToken: string; view: TicketClaimsView; }) {
  const withdraw = useSave();
  return (
    <section aria-labelledby="ticket-claims" className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-4">
      <div>
        <h2 id="ticket-claims" className="text-h4 text-ink">Claim expenses</h2>
        <p className="text-body-ui text-ink-secondary">The organisers pay back costs such as travel{view.cap ? `, up to ${view.cap} per person` : ""}. Add photos of your receipts.</p>
      </div>
      {withdraw.error ? <Callout tone="danger" role="alert">{withdraw.error}</Callout> : null}
      {view.claims.length > 0 ? (
        <ul aria-label="Your claims" className="flex flex-col divide-y divide-line">
          {view.claims.map((claim) => (
            <li key={claim.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-body-ui text-ink">{claim.approved && claim.approved !== claim.amount ? `${claim.approved} of ${claim.amount}` : claim.amount} · {claim.category}</p>
                {claim.note ? <p className="text-caption text-ink-muted">{claim.note}</p> : null}
              </div>
              <div className="flex items-center gap-2">
                <Chip tone={CLAIM_STATUS[claim.status]?.tone ?? "neutral"} size="sm">{CLAIM_STATUS[claim.status]?.label ?? claim.status}</Chip>
                {claim.status === "SUBMITTED" ? (
                  <Button size="sm" variant="quiet" startIcon={<Undo2 aria-hidden />} loading={withdraw.pending} onClick={() => withdraw.save(() => withdrawParticipantClaimAction(ticketToken, claim.id), "Claim withdrawn.")}>Withdraw</Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <ClaimForm kind="participant" hidden={{ ticketToken }} categories={view.categories} currency={view.currency} />
    </section>
  );
}
