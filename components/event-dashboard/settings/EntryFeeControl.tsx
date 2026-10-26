"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveEntryFee } from "@/app/actions/entry-fee";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/choice";
import { Callout, Card, CardHeader } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/field";

/** The hackathon entry fee (docs/HACKATHON.md), charged when a project is submitted. */
export function EntryFeeControl({ organisationSlug, eventId, currency, fee, refundOnDisqualify, paidBlockedReason }: {
  organisationSlug: string;
  eventId: string;
  currency: string;
  /** The current fee in major units, or "" when free. */
  fee: string;
  refundOnDisqualify: boolean;
  paidBlockedReason: string | null;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [amount, setAmount] = useState(fee);
  const [refund, setRefund] = useState(refundOnDisqualify);
  const [pending, startTransition] = useTransition();
  return (
    <Card as="section" className="rounded-xl" aria-labelledby="entry-fee-title">
      <CardHeader
        title={<span id="entry-fee-title">Project entry fee</span>}
        description="Entrants pay this once, on your payment page, when they submit a project. A project already paid for stays paid if it's withdrawn and submitted again."
      />
      {paidBlockedReason && !fee ? <Callout tone="info">{paidBlockedReason}</Callout> : null}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          startTransition(async () => {
            const result = await saveEntryFee({ organisationSlug, eventId, fee: amount, refundOnDisqualify: refund });
            if (!result.ok) return showToast(result.error, "error");
            showToast("Entry fee saved.", "success");
            router.refresh();
          });
        }}
      >
        <Field label={`Fee (${currency})`} helperText="Leave blank for free entry.">
          <Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} maxLength={20} placeholder="0" />
        </Field>
        <CheckboxField checked={refund} onCheckedChange={(checked) => setRefund(checked === true)} label="Refund the fee in full when a project is disqualified" />
        <div><Button type="submit" loading={pending} loadingLabel="Saving…">Save</Button></div>
      </form>
    </Card>
  );
}
