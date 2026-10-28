"use client";

import { useState } from "react";
import { saveReimbursementPolicyAction } from "@/app/actions/finance";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/choice";
import { Callout } from "@/components/ui/display";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Dropdown, Field, Input } from "@/components/ui/field";
import { ELIGIBILITY_LABELS, ELIGIBILITY_STAGE } from "@/lib/claims/policyLabels";
import { CREW_KINDS, CREW_KIND_LABELS } from "@/lib/crewKind";
import type { PolicyAdminRow } from "@/lib/claims/policies/view";
import { useSave, type FinanceScope } from "./shared";

/** Create or edit one reimbursement policy (docs/FINANCE.md "Reimbursement policies"). */

export type PolicyOptions = {
  judgingRounds: Array<{ id: string; name: string; }>;
  mentoringRounds: Array<{ id: string; name: string; }>;
  categories: Array<{ value: string; label: string; }>;
};

type PolicyInput = PolicyAdminRow["input"];

const EMPTY: PolicyInput = {
  policyId: "", name: "", eligibility: "CONFIRMED_PARTICIPANT", judgingRoundId: "", mentoringRoundId: "", requireFinalistsPublished: false, crewKinds: [],
  cap: "", categories: ["TRAVEL", "ACCOMMODATION"], claimOpensAt: "", claimClosesAt: "", attendanceRequired: false, budget: "", active: true, notifyWhenAvailable: false,
};

export function PolicyDialog({ scope, initial, options, currency, onClose }: { scope: FinanceScope; initial: PolicyInput | null; options: PolicyOptions; currency: string; onClose: () => void; }) {
  const [form, setForm] = useState<PolicyInput>(initial ?? EMPTY);
  const { pending, error, save } = useSave();
  const set = <K extends keyof PolicyInput>(key: K, value: PolicyInput[K]) => setForm((current) => ({ ...current, [key]: value }));
  const stage = ELIGIBILITY_STAGE[form.eligibility];
  const rounds = stage === "judging" ? options.judgingRounds : stage === "mentoring" ? options.mentoringRounds : [];
  const roundKey = stage === "judging" ? "judgingRoundId" : "mentoringRoundId";
  const toggleCategory = (value: string, on: boolean) => set("categories", on ? [...form.categories, value] : form.categories.filter((category) => category !== value));
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader title={initial ? "Edit reimbursement policy" : "Add a reimbursement policy"} description="Who may claim, how much each, for what and when. Claims keep the terms they were filed under." />
        <DialogBody className="pb-6">
          <form className="flex flex-col gap-4" onSubmit={(event) => {
            event.preventDefault();
            const input = { ...form, crewKinds: form.eligibility === "CREW" ? form.crewKinds : [], judgingRoundId: stage === "judging" ? form.judgingRoundId : "", mentoringRoundId: stage === "mentoring" ? form.mentoringRoundId : "" };
            save(() => saveReimbursementPolicyAction(scope, input), initial ? "Policy saved." : "Policy added.", onClose);
          }}>
            {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
            <Field label="Name" helperText="Participants see it, for example Finalist travel.">
              <Input value={form.name} onChange={(event) => set("name", event.target.value)} maxLength={80} required />
            </Field>
            <Field label="Who can claim">
              <Dropdown value={form.eligibility} onChange={(event) => set("eligibility", event.target.value)}>
                {Object.entries(ELIGIBILITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Dropdown>
            </Field>
            {stage ? (
              <Field label={stage === "judging" ? "Judging round" : "Mentoring round"} helperText={rounds.length === 0 ? (stage === "judging" ? "Add a judging round that takes advanced projects first." : "Add a mentoring round on the Mentor Desk first.") : undefined}>
                <Dropdown value={form[roundKey]} onChange={(event) => set(roundKey, event.target.value)} required>
                  <option value="">Choose a round</option>
                  {rounds.map((round) => <option key={round.id} value={round.id}>{round.name}</option>)}
                </Dropdown>
              </Field>
            ) : null}
            {stage === "judging" ? (
              <CheckboxField checked={form.requireFinalistsPublished} onCheckedChange={(checked) => set("requireFinalistsPublished", checked === true)} label="Only once this round's finalists are published" />
            ) : null}
            {form.eligibility === "CREW" ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-body-ui font-semibold text-ink">Which crew</legend>
                <p className="text-caption text-ink-muted">Leave all unticked for every crew member.</p>
                <div className="grid gap-2 sm:grid-cols-4">
                  {CREW_KINDS.map((kind) => (
                    <CheckboxField key={kind} checked={form.crewKinds.includes(kind)} onCheckedChange={(checked) => set("crewKinds", checked === true ? [...form.crewKinds, kind] : form.crewKinds.filter((value) => value !== kind))} label={CREW_KIND_LABELS[kind]} />
                  ))}
                </div>
              </fieldset>
            ) : null}
            <Field label={`Most each person gets back (${currency})`}>
              <Input inputMode="decimal" value={form.cap} onChange={(event) => set("cap", event.target.value)} maxLength={20} placeholder="0" required />
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-body-ui font-semibold text-ink">What it covers</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {options.categories.map((category) => (
                  <CheckboxField key={category.value} checked={form.categories.includes(category.value)} onCheckedChange={(checked) => toggleCategory(category.value, checked === true)} label={category.label} />
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Claims open" optional helperText="Event time. Blank is now.">
                <Input type="datetime-local" value={form.claimOpensAt} onChange={(event) => set("claimOpensAt", event.target.value)} />
              </Field>
              <Field label="Claims close" optional helperText="Event time. Blank is no deadline.">
                <Input type="datetime-local" value={form.claimClosesAt} onChange={(event) => set("claimClosesAt", event.target.value)} />
              </Field>
            </div>
            <Field label={`Budget for this policy (${currency})`} optional helperText="Waiting and approved claims count against it. Blank is no limit.">
              <Input inputMode="decimal" value={form.budget} onChange={(event) => set("budget", event.target.value)} maxLength={20} placeholder="0" />
            </Field>
            <CheckboxField checked={form.attendanceRequired} onCheckedChange={(checked) => set("attendanceRequired", checked === true)} label="Only people checked in at the event" description="Checked again when a claim is approved, so an undone check-in stops it." />
            <CheckboxField checked={form.notifyWhenAvailable} onCheckedChange={(checked) => set("notifyWhenAvailable", checked === true)} label="Email people when they can claim" description="Once each, when the policy opens to them (for example when finalists are published)." />
            <CheckboxField checked={form.active} onCheckedChange={(checked) => set("active", checked === true)} label="Open to new claims" />
            <div><Button type="submit" loading={pending} loadingLabel="Saving…">{initial ? "Save policy" : "Add policy"}</Button></div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
