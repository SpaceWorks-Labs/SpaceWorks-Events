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
type PolicyOption = { id: string; name: string; left: string; categories: Array<{ value: string; label: string; }>; };

export function ClaimForm({ kind, hidden, categories, currency, note, policies = [], general = true }: {
  /** Staff claim on the event dashboard, or a participant's from their ticket. */
  kind: "staff" | "participant";
  /** Fields the action needs besides the form's own (event scope, or the ticket token). */
  hidden: Record<string, string>;
  categories: Array<{ value: string; label: string; }>;
  currency: string;
  note?: string | null;
  /** Participant and crew claims: reimbursement policies open to them now, with what is left. */
  policies?: PolicyOption[];
  /** Whether the event's general claims (no policy) are open too. */
  general?: boolean;
}) {
  const action = kind === "staff" ? submitStaffClaimAction : submitParticipantClaimAction;
  const formRef = useRef<HTMLFormElement>(null);
  const [chosen, setPolicyId] = useState(general ? "" : (policies[0]?.id ?? ""));
  // A policy can drop out of the list after a refresh (closed, or its budget used up): fall back.
  const listed = chosen === "" ? general : policies.some((option) => option.id === chosen);
  const policyId = listed ? chosen : general ? "" : (policies[0]?.id ?? "");
  const policy = policies.find((option) => option.id === policyId);
  const choices = policy ? policy.categories : categories;
  const [picked, setCategory] = useState(choices[0]?.value ?? "OTHER");
  const category = choices.some((option) => option.value === picked) ? picked : (choices[0]?.value ?? "OTHER");
  const { pending, error, save } = useSave();
  return (
    <form
      ref={formRef}
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        for (const [name, value] of Object.entries(hidden)) formData.set(name, value);
        formData.set("category", category);
        if (kind === "participant") formData.set("policyId", policyId);
        save(() => action(formData), "Claim sent. The organisers will email you when it's decided.", () => formRef.current?.reset());
      }}
    >
      {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      {note ? <p className="text-caption text-ink-muted">{note}</p> : null}
      {policies.length > 0 ? (
        <Field label="Claim under" helperText={policy ? `${policy.left} left for you under ${policy.name}.` : "The event's general expense claims."}>
          <Dropdown value={policyId} onChange={(event) => setPolicyId(event.target.value)}>
            {general ? <option value="">General expenses</option> : null}
            {policies.map((option) => <option key={option.id} value={option.id}>{option.name} ({option.left} left)</option>)}
          </Dropdown>
        </Field>
      ) : null}
      <Field label="What for">
        <Dropdown name="category" value={category} onChange={(event) => setCategory(event.target.value)}>
          {choices.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
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
