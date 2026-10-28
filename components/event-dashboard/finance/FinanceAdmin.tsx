"use client";

import { useState } from "react";
import { Check, Undo2, X } from "lucide-react";
import { decideRefundRequestAction, reverseClaimPayoutAction, saveFinanceSettingsAction } from "@/app/actions/finance";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/choice";
import { Callout, Chip } from "@/components/ui/display";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { formatDayTime } from "@/lib/format/datetime";
import type { EventFinanceView } from "@/lib/finance";
import { REQUEST_STATUS, useSave, type FinanceScope } from "./shared";

/** Owner/admin parts of the Finance tab: settings, refund requests and claim payouts (docs/FINANCE.md). */

export function FinanceSettingsForm({ scope, settings, currency }: { scope: FinanceScope; settings: EventFinanceView["settings"]; currency: string; }) {
  const [budget, setBudget] = useState(settings.budget);
  const [claims, setClaims] = useState(settings.participantClaimsEnabled);
  const [cap, setCap] = useState(settings.participantCap);
  const [crewClaims, setCrewClaims] = useState(settings.crewClaimsEnabled);
  const { pending, error, save } = useSave();
  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(() => saveFinanceSettingsAction(scope, { budget, participantClaimsEnabled: claims, participantCap: cap, crewClaimsEnabled: crewClaims }), "Finance settings saved."); }}>
      {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      <Field label={`Budget (${currency})`} optional helperText="What the event may spend on claims and prizes. Leave blank for none.">
        <Input inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} maxLength={20} placeholder="0" />
      </Field>
      <CheckboxField checked={claims} onCheckedChange={(checked) => setClaims(checked === true)} label="Let confirmed participants claim expenses from their ticket page" />
      {claims ? (
        <Field label={`Most each participant can claim (${currency})`} optional helperText="Travel grants, for example. Leave blank for no limit.">
          <Input inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} maxLength={20} placeholder="0" />
        </Field>
      ) : null}
      <CheckboxField checked={crewClaims} onCheckedChange={(checked) => setCrewClaims(checked === true)} label="Let crew claim expenses from their crew ticket page" description="No limit: owners and admins approve each claim." />
      <div><Button type="submit" variant="secondary" loading={pending} loadingLabel="Saving…">Save</Button></div>
    </form>
  );
}

type Request = EventFinanceView["refundRequests"][number];

export function RefundRequestsList({ scope, requests, timezone, currency }: { scope: FinanceScope; requests: Request[]; timezone: string; currency: string; }) {
  const [deciding, setDeciding] = useState<{ request: Request; decision: "approve" | "decline"; } | null>(null);
  if (requests.length === 0) return <p className="text-caption text-ink-muted">No refund requests.</p>;
  return (
    <>
      <ul className="flex flex-col divide-y divide-line">
        {requests.map((request) => (
          <li key={request.id} className="flex flex-col gap-2 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-body-ui font-semibold text-ink">{request.buyer} · order {request.reference} · {request.orderTotal}</p>
                <p className="text-caption text-ink-muted">{formatDayTime(request.createdAt, timezone)}{request.approved ? ` · refunded ${request.approved}${request.cancelTickets ? ", tickets cancelled" : ""}` : ""}</p>
                <p className="mt-1 whitespace-pre-line text-body-ui text-ink-secondary">{request.reason}</p>
                {request.note ? <p className="mt-1 text-caption text-ink-muted">Note: {request.note}</p> : null}
              </div>
              <Chip tone={REQUEST_STATUS[request.status]?.tone ?? "neutral"} size="sm">{REQUEST_STATUS[request.status]?.label ?? request.status}</Chip>
            </div>
            {request.open ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" startIcon={<Check aria-hidden />} onClick={() => setDeciding({ request, decision: "approve" })}>Refund…</Button>
                <Button size="sm" variant="quiet" startIcon={<X aria-hidden />} onClick={() => setDeciding({ request, decision: "decline" })}>Decline…</Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {deciding ? <RequestDialog scope={scope} currency={currency} target={deciding} onClose={() => setDeciding(null)} /> : null}
    </>
  );
}

function RequestDialog({ scope, currency, target, onClose }: { scope: FinanceScope; currency: string; target: { request: Request; decision: "approve" | "decline"; }; onClose: () => void; }) {
  const [amount, setAmount] = useState("");
  const [cancelTickets, setCancelTickets] = useState(false);
  const [note, setNote] = useState("");
  const { pending, error, save } = useSave();
  const approve = target.decision === "approve";
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader title={approve ? "Refund this order" : "Decline this request"} description={`${target.request.buyer} · order ${target.request.reference} · ${target.request.orderTotal}`} />
        <DialogBody className="pb-6">
          <form className="flex flex-col gap-4" onSubmit={(event) => {
            event.preventDefault();
            save(() => decideRefundRequestAction(scope, { requestId: target.request.id, decision: target.decision, amount, cancelTickets, note }), approve ? "Refund sent." : "Request declined.", onClose);
          }}>
            {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
            {approve ? (
              <>
                <Field label={`Amount (${currency})`} optional helperText="Leave blank to refund everything still refundable."><Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} maxLength={20} /></Field>
                <CheckboxField checked={cancelTickets} onCheckedChange={(checked) => setCancelTickets(checked === true)} label="Also cancel the tickets" />
              </>
            ) : null}
            <Field label={approve ? "Note" : "Why (the buyer sees this)"} optional={approve}><Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={2} required={!approve} /></Field>
            <div><Button type="submit" variant={approve ? "primary" : "danger"} loading={pending} loadingLabel="Saving…">{approve ? "Refund" : "Decline"}</Button></div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

type Payout = EventFinanceView["payouts"][number];

export function ClaimPayoutsList({ scope, payouts, timezone }: { scope: FinanceScope; payouts: Payout[]; timezone: string; }) {
  const [reversing, setReversing] = useState<Payout | null>(null);
  const [reason, setReason] = useState("");
  const { pending, error, save } = useSave();
  if (payouts.length === 0) return <p className="text-caption text-ink-muted">No claims paid yet.</p>;
  return (
    <>
      <ul className="flex flex-col divide-y divide-line">
        {payouts.map((payout) => (
          <li key={payout.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-body-ui font-semibold text-ink">{payout.amount} · {payout.payeeName}</p>
              <p className="text-caption text-ink-muted">{payout.method}{payout.reference ? ` · ${payout.reference}` : ""} · {formatDayTime(payout.paidAt, timezone)}{payout.note ? ` · ${payout.note}` : ""}</p>
            </div>
            {payout.isReversal ? <Chip tone="neutral" size="sm">Reversal</Chip> : payout.reversed ? <Chip tone="warning" size="sm">Reversed</Chip>
              : <Button variant="quiet" size="sm" startIcon={<Undo2 aria-hidden />} onClick={() => { setReason(""); setReversing(payout); }}>Reverse…</Button>}
          </li>
        ))}
      </ul>
      {reversing ? (
        <Dialog open onOpenChange={(next) => { if (!next) setReversing(null); }}>
          <DialogContent size="md">
            <DialogHeader title="Reverse this payment?" description={`${reversing.amount} to ${reversing.payeeName}. The claim goes back to approved; the original stays on record.`} />
            <DialogBody className="pb-6">
              <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(() => reverseClaimPayoutAction(scope, { payoutId: reversing.id, reason }), "Payment reversed.", () => setReversing(null)); }}>
                {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
                <Field label="Why"><Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} required /></Field>
                <div><Button type="submit" variant="danger" loading={pending} loadingLabel="Reversing…">Reverse payment</Button></div>
              </form>
            </DialogBody>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
