"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestRefundAction } from "@/app/actions/participant-claims";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/display";
import { Field, Textarea } from "@/components/ui/field";

/** Ask the organisers for a refund outside the automatic policy (docs/FINANCE.md). */
export function RefundRequestForm({ orderToken }: { orderToken: string; }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await requestRefundAction(orderToken, reason);
          if (!result.ok) return setError(result.error);
          router.refresh();
        });
      }}
    >
      {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      <Field label="Why you're asking" helperText="The organisers decide, and reply by email.">
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={3} required />
      </Field>
      <div><Button type="submit" variant="secondary" loading={pending} loadingLabel="Sending…">Ask for a refund</Button></div>
    </form>
  );
}
