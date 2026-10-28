"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HandCoins, Undo2 } from "lucide-react";
import { recordPrizePayoutAction, reversePrizePayoutAction, setAwardPrizeAction } from "@/app/actions/prizes";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader, Chip } from "@/components/ui/display";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Dropdown, Field, Input, Textarea } from "@/components/ui/field";
import { OFFLINE_METHOD_LABELS } from "@/lib/payments/paymentMethod";
import { formatDayTime } from "@/lib/format/datetime";
import type { PrizeLedgerView } from "@/lib/prizeLedger";
import { HelpLink } from "@/components/help/HelpLink";

type Scope = { organisationSlug: string; eventId: string; };
type Winner = PrizeLedgerView["awards"][number]["winners"][number];
type Payout = PrizeLedgerView["payouts"][number];

/** Judging → Prizes (docs/HACKATHON.md): prize per award, payouts recorded by hand, and reversals. */
export function PrizePayouts({ scope, ledger, timezone }: { scope: Scope; ledger: PrizeLedgerView; timezone: string; }) {
  const [paying, setPaying] = useState<{ awardId: string; awardName: string; winner: Winner; } | null>(null);
  const [reversing, setReversing] = useState<Payout | null>(null);
  return (
    <div className="flex flex-col gap-5">
      <p className="text-body-ui text-ink-secondary">Prizes {ledger.totals.prizes} · Paid {ledger.totals.paid}</p>
      {ledger.awards.length === 0 ? <Callout tone="info">Add awards under Awards first. Each award can carry prize money for its winners.</Callout> : null}
      {ledger.awards.map((award) => (
        <Card key={award.id} as="section" className="rounded-xl" aria-label={award.name}>
          <CardHeader title={award.name} description={award.prizeLabel ? `${award.prizeLabel} per winner` : "No prize money"} />
          <PrizeForm scope={scope} awardId={award.id} prize={award.prize} currency={ledger.currency} />
          {award.winners.length === 0 ? <p className="mt-3 text-caption text-ink-muted">No winners picked yet.</p> : (
            <ul className="mt-3 flex flex-col divide-y divide-line">
              {award.winners.map((winner) => (
                <li key={winner.submissionId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-body-ui font-semibold text-ink">{winner.title}</p>
                    <p className="text-caption text-ink-muted">Place {winner.place} · {winner.entrant} · Paid {winner.paidLabel}</p>
                  </div>
                  <Button variant="secondary" startIcon={<HandCoins aria-hidden />} onClick={() => setPaying({ awardId: award.id, awardName: award.name, winner })}>Record payout</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
      <Card as="section" className="rounded-xl" aria-labelledby="prize-ledger-title">
        <CardHeader title={<span id="prize-ledger-title">Payouts</span>} description="Every payout stays on record. A mistake is reversed, never edited." action={<HelpLink article="hackathons/prize-payouts" />} />
        {ledger.payouts.length === 0 ? <p className="text-caption text-ink-muted">Nothing paid out yet.</p> : (
          <ul className="flex flex-col divide-y divide-line">
            {ledger.payouts.map((payout) => (
              <li key={payout.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-body-ui font-semibold text-ink">{payout.amountLabel} · {payout.recipientName}</p>
                  <p className="text-caption text-ink-muted">
                    {payout.awardName} · {payout.projectTitle} · {payout.method}{payout.reference ? ` · ${payout.reference}` : ""} · {formatDayTime(payout.paidAt, timezone)}
                  </p>
                  {payout.note ? <p className="text-caption text-ink-muted">{payout.note}</p> : null}
                </div>
                {payout.isReversal ? <Chip tone="neutral" size="sm">Reversal</Chip>
                  : payout.reversed ? <Chip tone="warning" size="sm">Reversed</Chip>
                    : <Button variant="quiet" startIcon={<Undo2 aria-hidden />} onClick={() => setReversing(payout)}>Reverse…</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {paying ? <PayoutDialog scope={scope} currency={ledger.currency} target={paying} onClose={() => setPaying(null)} /> : null}
      {reversing ? <ReverseDialog scope={scope} payout={reversing} onClose={() => setReversing(null)} /> : null}
    </div>
  );
}

function useSave() {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function save(task: () => Promise<{ ok: boolean; error?: string; }>, done: string, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await task();
      if (!result.ok) return setError(result.error ?? "Couldn't save that.");
      showToast(done, "success");
      after?.();
      router.refresh();
    });
  }
  return { pending, error, save };
}

function PrizeForm({ scope, awardId, prize, currency }: { scope: Scope; awardId: string; prize: string; currency: string; }) {
  const [value, setValue] = useState(prize);
  const { pending, error, save } = useSave();
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); save(() => setAwardPrizeAction(scope, { awardId, prize: value }), "Prize saved."); }}>
      <Field label={`Prize per winner (${currency})`} helperText="Leave blank for no prize money." error={error ?? undefined}>
        <Input inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} maxLength={20} placeholder="0" />
      </Field>
      <Button type="submit" variant="secondary" loading={pending} loadingLabel="Saving…" disabled={value === prize}>Save prize</Button>
    </form>
  );
}

function PayoutDialog({ scope, currency, target, onClose }: { scope: Scope; currency: string; target: { awardId: string; awardName: string; winner: Winner; }; onClose: () => void; }) {
  const [recipientName, setRecipientName] = useState(target.winner.entrant);
  const [amount, setAmount] = useState(target.winner.owed);
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const { pending, error, save } = useSave();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader title="Record a prize payout" description={`${target.awardName} · ${target.winner.title}`} />
        <DialogBody className="pb-6">
          <form className="flex flex-col gap-4" onSubmit={(event) => {
            event.preventDefault();
            save(() => recordPrizePayoutAction(scope, { awardId: target.awardId, submissionId: target.winner.submissionId, recipientName, amount, method, reference: reference || undefined, note, paidOn }), "Payout recorded.", onClose);
          }}>
            {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
            <Field label="Paid to"><Input value={recipientName} onChange={(event) => setRecipientName(event.target.value)} maxLength={120} required /></Field>
            <Field label={`Amount (${currency})`}><Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} maxLength={20} required /></Field>
            <Field label="How it was paid">
              <Dropdown value={method} onChange={(event) => setMethod(event.target.value)}>
                {Object.entries(OFFLINE_METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Dropdown>
            </Field>
            <Field label="Reference" optional helperText="A transfer or UPI reference, cheque number or receipt."><Input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={120} /></Field>
            <Field label="Paid on"><Input type="date" value={paidOn} onChange={(event) => setPaidOn(event.target.value)} required /></Field>
            <Field label="Note" optional><Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={2} /></Field>
            <div><Button type="submit" loading={pending} loadingLabel="Saving…">Record payout</Button></div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function ReverseDialog({ scope, payout, onClose }: { scope: Scope; payout: Payout; onClose: () => void; }) {
  const [reason, setReason] = useState("");
  const { pending, error, save } = useSave();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader title="Reverse this payout?" description={`${payout.amountLabel} to ${payout.recipientName}. The original stays on record with a reversal beside it.`} />
        <DialogBody className="pb-6">
          <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(() => reversePrizePayoutAction(scope, { payoutId: payout.id, reason }), "Payout reversed.", onClose); }}>
            {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
            <Field label="Why"><Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} required /></Field>
            <div><Button type="submit" variant="danger" loading={pending} loadingLabel="Reversing…">Reverse payout</Button></div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
