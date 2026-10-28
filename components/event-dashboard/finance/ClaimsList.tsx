"use client";

import { useState } from "react";
import { Check, HandCoins, ImageIcon, Undo2, X } from "lucide-react";
import { approveClaimAction, recordClaimPayoutAction, rejectClaimAction, withdrawStaffClaimAction } from "@/app/actions/finance";
import { Button } from "@/components/ui/button";
import { Callout, Chip } from "@/components/ui/display";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Dropdown, Field, Input, Textarea } from "@/components/ui/field";
import { OFFLINE_METHOD_LABELS } from "@/lib/payments/paymentMethod";
import { formatDayTime } from "@/lib/format/datetime";
import { CLAIM_STATUS, useSave, type FinanceScope } from "./shared";

export type ClaimRow = {
  id: string;
  status: string;
  category: string;
  description: string;
  amount: string;
  approved: string | null;
  note: string;
  createdAt: string;
  receiptIds: string[];
  payeeName?: string;
  payeeEmail?: string;
  kind?: string;
  approvedInput?: string;
  /** Reimbursement policy (docs/FINANCE.md "Reimbursement policies"). */
  policyId?: string | null;
  policy?: string | null;
  /** For approvers: why the person no longer qualifies under the policy, if so. */
  eligibilityChanged?: string | null;
};

type Dialogs = { kind: "approve" | "reject" | "pay"; claim: ClaimRow; } | null;

/** Claims on the Finance tab: everything for owners and admins, your own for everyone else. */
export function ClaimsList({ scope, claims, admin, timezone, currency }: { scope: FinanceScope; claims: ClaimRow[]; admin: boolean; timezone: string; currency: string; }) {
  const [open, setOpen] = useState<Dialogs>(null);
  const [filter, setFilter] = useState("all");
  const withdraw = useSave();
  const policies = [...new Map(claims.flatMap((claim) => (claim.policyId && claim.policy ? [[claim.policyId, claim.policy] as const] : []))).entries()];
  const shown = filter === "all" ? claims : claims.filter((claim) => (filter === "none" ? !claim.policyId : claim.policyId === filter));
  if (claims.length === 0) return <p className="text-caption text-ink-muted">{admin ? "No expense claims yet." : "You haven't claimed anything for this event."}</p>;
  return (
    <>
      {withdraw.error ? <Callout tone="danger" role="alert">{withdraw.error}</Callout> : null}
      {admin && policies.length > 0 ? (
        <Field label="Policy">
          <Dropdown value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">All claims</option>
            <option value="none">No policy</option>
            {policies.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Dropdown>
        </Field>
      ) : null}
      <ul className="flex flex-col divide-y divide-line">
        {shown.map((claim) => (
          <li key={claim.id} className="flex flex-col gap-2 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-body-ui font-semibold text-ink">{claim.approved && claim.approved !== claim.amount ? `${claim.approved} of ${claim.amount}` : claim.amount} · {claim.category}</p>
                <p className="text-caption text-ink-muted">
                  {claim.payeeName ? `${claim.payeeName}${claim.kind === "PARTICIPANT" ? " (participant)" : claim.kind === "CREW" ? " (crew)" : ""} · ` : ""}{formatDayTime(claim.createdAt, timezone)}
                </p>
                {claim.policy ? <p className="text-caption text-ink-muted">Policy: {claim.policy}</p> : null}
                <p className="mt-1 whitespace-pre-line text-body-ui text-ink-secondary">{claim.description}</p>
                {admin && claim.eligibilityChanged ? <Callout tone="warning" className="mt-2" title="Eligibility changed since submission">{claim.eligibilityChanged} Approval is refused until it is met again; you can reject the claim.</Callout> : null}
                {claim.note ? <p className="mt-1 text-caption text-ink-muted">Note: {claim.note}</p> : null}
              </div>
              <Chip tone={CLAIM_STATUS[claim.status]?.tone ?? "neutral"} size="sm">{CLAIM_STATUS[claim.status]?.label ?? claim.status}</Chip>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {claim.receiptIds.map((id, index) => (
                <Button key={id} asChild size="sm" variant="quiet">
                  <a href={`/api/claims/receipts/${id}`} target="_blank" rel="noreferrer"><ImageIcon aria-hidden className="size-4" />Receipt {index + 1}</a>
                </Button>
              ))}
              {admin && claim.status === "SUBMITTED" ? (
                <>
                  <Button size="sm" variant="secondary" startIcon={<Check aria-hidden />} onClick={() => setOpen({ kind: "approve", claim })}>Approve…</Button>
                  <Button size="sm" variant="quiet" startIcon={<X aria-hidden />} onClick={() => setOpen({ kind: "reject", claim })}>Reject…</Button>
                </>
              ) : null}
              {admin && claim.status === "APPROVED" ? <Button size="sm" variant="secondary" startIcon={<HandCoins aria-hidden />} onClick={() => setOpen({ kind: "pay", claim })}>Record payment…</Button> : null}
              {!admin && claim.status === "SUBMITTED" ? (
                <Button size="sm" variant="quiet" startIcon={<Undo2 aria-hidden />} loading={withdraw.pending} onClick={() => withdraw.save(() => withdrawStaffClaimAction(scope, claim.id), "Claim withdrawn.")}>Withdraw</Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {open ? <DecisionDialog scope={scope} open={open} currency={currency} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function DecisionDialog({ scope, open, currency, onClose }: { scope: FinanceScope; open: NonNullable<Dialogs>; currency: string; onClose: () => void; }) {
  const { claim } = open;
  const [amount, setAmount] = useState(claim.approvedInput ?? "");
  const [note, setNote] = useState("");
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const { pending, error, save } = useSave();
  const title = open.kind === "approve" ? "Approve this claim" : open.kind === "reject" ? "Reject this claim" : "Record the payment";
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader title={title} description={`${claim.payeeName ?? ""} · ${claim.amount} · ${claim.category}`} />
        <DialogBody className="pb-6">
          <form className="flex flex-col gap-4" onSubmit={(event) => {
            event.preventDefault();
            if (open.kind === "approve") save(() => approveClaimAction(scope, { claimId: claim.id, amount, note }), "Claim approved.", onClose);
            else if (open.kind === "reject") save(() => rejectClaimAction(scope, { claimId: claim.id, note }), "Claim rejected.", onClose);
            else save(() => recordClaimPayoutAction(scope, { claimId: claim.id, method, reference: reference || undefined, note, paidOn }), "Payment recorded.", onClose);
          }}>
            {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
            {open.kind === "approve" ? <Field label={`Approve (${currency})`} helperText="Up to the amount asked."><Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} maxLength={20} /></Field> : null}
            {open.kind === "pay" ? (
              <>
                <p className="text-body-ui text-ink-secondary">Paying {claim.approved} to {claim.payeeName}.</p>
                <Field label="How it was paid">
                  <Dropdown value={method} onChange={(event) => setMethod(event.target.value)}>
                    {Object.entries(OFFLINE_METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </Dropdown>
                </Field>
                <Field label="Reference" optional><Input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={120} /></Field>
                <Field label="Paid on"><Input type="date" value={paidOn} onChange={(event) => setPaidOn(event.target.value)} required /></Field>
              </>
            ) : null}
            <Field label={open.kind === "reject" ? "Why (the claimant sees this)" : "Note"} optional={open.kind !== "reject"}>
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={2} required={open.kind === "reject"} />
            </Field>
            <div><Button type="submit" variant={open.kind === "reject" ? "danger" : "primary"} loading={pending} loadingLabel="Saving…">{open.kind === "approve" ? "Approve" : open.kind === "reject" ? "Reject claim" : "Record payment"}</Button></div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
