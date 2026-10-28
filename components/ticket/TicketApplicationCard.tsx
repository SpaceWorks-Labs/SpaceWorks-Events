"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { respondToApplicationOffer, saveApplicationAnswers } from "@/app/actions/admission-applicant";
import type { TicketApplicationView } from "@/lib/admission/ticketView";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/choice";
import { Callout, Chip } from "@/components/ui/display";
import { Dropdown, Field, Input, Textarea } from "@/components/ui/field";

type EditField = NonNullable<TicketApplicationView["edit"]>["fields"][number];

/**
 * "Your application" on the ticket page (docs/ADMISSION.md): where it stands,
 * the offer and its deadline, Accept (or Accept and pay), Decline, Withdraw,
 * and editing answers until the first decision. The ticket token is the
 * bearer, as for cancelling.
 */
export function TicketApplicationCard({ token, view }: { token: string; view: TicketApplicationView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [answers, setAnswers] = useState<Record<string, unknown>>(() => Object.fromEntries((view.edit?.fields ?? []).map((field) => [field.key, field.type === "MULTI_SELECT" ? field.values : field.type === "CHECKBOX" ? field.value === "true" : field.value])));

  const act = (response: "accept" | "decline" | "withdraw") => startTransition(async () => {
    setError(null);
    const result = await respondToApplicationOffer({ token, response }).catch(() => ({ ok: false as const, error: "That didn't go through. Try again." }));
    if (!result.ok) setError(result.error);
    router.refresh();
  });
  const save = () => startTransition(async () => {
    setError(null);
    const result = await saveApplicationAnswers({ token, answers }).catch(() => ({ ok: false as const, error: "That didn't save. Try again." }));
    if (!result.ok) setError(result.error);
    else setEditing(false);
    router.refresh();
  });

  return (
    <section aria-labelledby="your-application" className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="your-application" className="text-h4 text-ink">{view.teamName ? "Your team's application" : "Your application"}</h2>
        <Chip tone={view.status === "ACCEPTED" ? "success" : view.status === "OFFERED" ? "accent" : view.status === "IN_REVIEW" || view.status === "WAITLISTED" ? "info" : "neutral"}>{view.statusLabel}</Chip>
      </div>
      {view.stageName ? <p className="text-body-ui text-ink-muted">Stage: {view.stageName}. We&apos;ll email you when there&apos;s a decision.</p> : null}
      {view.status === "WAITLISTED" ? <p className="text-body-ui text-ink-muted">If a place opens up, it goes to the waitlist in the order people joined. We&apos;ll email you.</p> : null}
      {view.status === "OFFERED" ? (
        view.paying ? (
          <Callout tone="info">Your place is held while you pay. Use the payment button above; it&apos;s confirmed once paid.</Callout>
        ) : view.canAnswer ? (
          <>
            <p className="text-body-ui text-ink">You&apos;re offered a place. Answer by {view.respondBy}.{view.paid ? " Your place is confirmed once it's paid for." : ""}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={pending} onClick={() => act("accept")}>{view.paid ? "Accept and pay" : "Accept"}</Button>
              <Button variant="secondary" disabled={pending} onClick={() => act("decline")}>Decline</Button>
            </div>
          </>
        ) : (
          <p className="text-body-ui text-ink-muted">Your team is offered a place. Your team leader answers by {view.respondBy}.</p>
        )
      ) : null}
      {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      {view.edit && !editing ? <div><Button variant="quiet" onClick={() => setEditing(true)}>Edit answers</Button></div> : null}
      {view.edit && editing ? (
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); save(); }}>
          {view.edit.fields.map((field) => <AnswerInput key={field.key} field={field} value={answers[field.key]} onChange={(value) => setAnswers((current) => ({ ...current, [field.key]: value }))} />)}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={pending}>Save answers</Button>
            <Button type="button" variant="quiet" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : null}
      {view.canWithdraw && !editing ? <div><Button variant="dangerQuiet" disabled={pending} onClick={() => act("withdraw")}>Withdraw application</Button></div> : null}
    </section>
  );
}

function AnswerInput({ field, value, onChange }: { field: EditField; value: unknown; onChange: (value: unknown) => void }) {
  if (field.type === "CHECKBOX") return <CheckboxField label={field.label} checked={value === true} onCheckedChange={(checked) => onChange(checked === true)} />;
  if (field.type === "MULTI_SELECT") {
    const picked = Array.isArray(value) ? (value as string[]) : [];
    return (
      <Field label={field.label} optional={!field.required}>
        <div className="flex flex-col gap-1">
          {field.options.map((option) => <CheckboxField key={option} label={option} checked={picked.includes(option)} onCheckedChange={(checked) => onChange(checked ? [...picked, option] : picked.filter((item) => item !== option))} />)}
        </div>
      </Field>
    );
  }
  const text = typeof value === "string" ? value : "";
  return (
    <Field label={field.label} optional={!field.required}>
      {field.type === "SELECT" || field.type === "RADIO" ? (
        <Dropdown value={text} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose</option>
          {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </Dropdown>
      ) : field.type === "TEXTAREA" ? (
        <Textarea value={text} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <Input type={field.type === "NUMBER" ? "number" : field.type === "DATE" ? "date" : field.type === "EMAIL" ? "email" : field.type === "PHONE" ? "tel" : "text"} value={text} onChange={(event) => onChange(event.target.value)} />
      )}
    </Field>
  );
}
