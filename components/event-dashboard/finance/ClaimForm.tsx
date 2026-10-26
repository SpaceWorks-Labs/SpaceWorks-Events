"use client";

import { useRef, useState } from "react";
import { Receipt } from "lucide-react";
import { submitStaffClaimAction } from "@/app/actions/finance";
import { submitParticipantClaimAction } from "@/app/actions/participant-claims";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/display";
import { Dropdown, Field, Input, Textarea } from "@/components/ui/field";
import { useSave } from "./shared";

/**
 * File an expense claim with up to three receipt photos (docs/FINANCE.md).
 * Staff can claim on behalf of someone else (a speaker or volunteer);
 * participants claim for themselves from their ticket page.
 */
export function ClaimForm({ kind, hidden, categories, currency, note }: {
  /** Staff claim on the event dashboard, or a participant's from their ticket. */
  kind: "staff" | "participant";
  /** Fields the action needs besides the form's own (event scope, or the ticket token). */
  hidden: Record<string, string>;
  categories: Array<{ value: string; label: string; }>;
  currency: string;
  note?: string | null;
}) {
  const action = kind === "staff" ? submitStaffClaimAction : submitParticipantClaimAction;
  const formRef = useRef<HTMLFormElement>(null);
  const [category, setCategory] = useState(categories[0]?.value ?? "OTHER");
  const { pending, error, save } = useSave();
  return (
    <form
      ref={formRef}
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        for (const [name, value] of Object.entries(hidden)) formData.set(name, value);
        save(() => action(formData), "Claim sent. The organisers will email you when it's decided.", () => formRef.current?.reset());
      }}
    >
      {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      {note ? <p className="text-caption text-ink-muted">{note}</p> : null}
      <Field label="What for">
        <Dropdown name="category" value={category} onChange={(event) => setCategory(event.target.value)}>
          {categories.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Dropdown>
      </Field>
      <Field label="Details" helperText="Where you went or what you bought, and why.">
        <Textarea name="description" maxLength={1000} rows={3} required />
      </Field>
      <Field label={`Amount (${currency})`}>
        <Input name="amount" inputMode="decimal" maxLength={20} placeholder="0" required />
      </Field>
      {kind === "staff" ? (
        <>
          <Field label="Paying back someone else?" optional helperText="A speaker or volunteer. Leave blank to be paid back yourself.">
            <Input name="payeeName" maxLength={120} placeholder="Their name" />
          </Field>
          <Field label="Their email" optional>
            <Input name="payeeEmail" type="email" maxLength={254} />
          </Field>
        </>
      ) : null}
      <Field label="Receipt photos" optional helperText="Up to 3 photos (JPEG, PNG or WebP), under 5 MB in all. Only the organisers see them.">
        <Input name="receipts" type="file" accept="image/jpeg,image/png,image/webp" multiple />
      </Field>
      <div><Button type="submit" startIcon={<Receipt aria-hidden />} loading={pending} loadingLabel="Sending…">Send claim</Button></div>
    </form>
  );
}
