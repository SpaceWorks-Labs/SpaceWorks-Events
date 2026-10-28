"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { CheckboxField, SwitchRow } from "@/components/ui/choice";
import { Dropdown, Field, Input } from "@/components/ui/field";
import { saveMentoringRoundAction } from "@/app/actions/mentor-desk";
import type { DeskOrganiserView } from "@/lib/core/mentorDesk/readsOrganiser";
import { ROUND_QUESTIONS_MAX, ROUND_TRIGGERS_MAX, type HelpTriggerRule, type RoundQuestion } from "@/lib/mentorDesk/roundForm";
import { type DeskScope, ErrorLine, splitTags, useDeskSave } from "../shared";

type Round = DeskOrganiserView["rounds"][number];
const TYPES = [{ value: "text", label: "Text" }, { value: "rating", label: "Rating 1–5" }, { value: "yesno", label: "Yes / no" }, { value: "choice", label: "Choice" }] as const;

const slug = (label: string, index: number) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || `q${index + 1}`;

/**
 * A round's (stage's) set-up, editable while it is a draft: its window, its
 * own check-in form, help triggers on the answers, the override rules and
 * fresh eyes across stages. None of its questions may ask a date of birth or age.
 */
export function RoundForm({ scope, round, categories, bounds }: { scope: DeskScope; round?: Round; categories: Array<{ key: string; label: string }>; bounds: { start: string; end: string } }) {
  const { pending, error, save } = useDeskSave();
  const [label, setLabel] = useState(round?.label ?? "");
  const [opens, setOpens] = useState(round?.opens ?? bounds.start);
  const [closes, setCloses] = useState(round?.closes ?? bounds.end);
  const [questions, setQuestions] = useState<Array<RoundQuestion & { optionsText?: string }>>(round?.formSchema.map((q) => ({ ...q, optionsText: q.options?.join(", ") })) ?? []);
  const [rules, setRules] = useState<HelpTriggerRule[]>(round?.helpTriggerRules ?? []);
  const [freshOverride, setFreshOverride] = useState(round?.allowFreshEyesOverride ?? false);
  const [conflictOverride, setConflictOverride] = useState(round?.allowConflictOverride ?? false);
  const [acrossStages, setAcross] = useState(round?.freshEyesAcrossStages ?? false);
  const editQ = (i: number, patch: Partial<RoundQuestion & { optionsText?: string }>) => setQuestions((list) => list.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const editR = (i: number, patch: Partial<HelpTriggerRule>) => setRules((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const formSchema = questions.map(({ optionsText, ...q }, i) => ({ ...q, id: q.id || slug(q.label, i), ...(q.type === "choice" ? { options: splitTags(optionsText ?? "") } : { options: undefined }) }));
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save(() => saveMentoringRoundAction({ ...scope, ...(round ? { roundId: round.id } : {}), expectedVersion: round?.version ?? 0, label, opensAt: opens, closesAt: closes, formSchema, helpTriggerRules: rules, allowFreshEyesOverride: freshOverride, allowConflictOverride: conflictOverride, freshEyesAcrossStages: acrossStages }), round ? "Round saved." : "Round added.");
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Field label="Name"><Input value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} /></Field>
        <Field label="Opens"><Input type="datetime-local" min={bounds.start} max={bounds.end} value={opens} onChange={(e) => setOpens(e.target.value)} /></Field>
        <Field label="Closes"><Input type="datetime-local" min={bounds.start} max={bounds.end} value={closes} onChange={(e) => setCloses(e.target.value)} /></Field>
      </div>
      <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
        <legend className="px-1 text-label text-ink">Check-in form</legend>
        {questions.map((q, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input aria-label="Question" placeholder="Question" value={q.label} maxLength={200} onChange={(e) => editQ(i, { label: e.target.value })} className="max-w-72" />
            <Dropdown aria-label="Type" value={q.type} onChange={(e) => editQ(i, { type: e.target.value as RoundQuestion["type"] })} className="max-w-40">
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Dropdown>
            {q.type === "choice" ? <Input aria-label="Options" placeholder="Options, separated by commas" value={q.optionsText ?? ""} onChange={(e) => editQ(i, { optionsText: e.target.value })} className="max-w-64" /> : null}
            <CheckboxField label="Required" checked={Boolean(q.required)} onCheckedChange={(v) => editQ(i, { required: v === true })} />
            <IconButton label="Remove question" variant="danger" onClick={() => setQuestions((list) => list.filter((_, j) => j !== i))}><Trash2 aria-hidden className="size-4" /></IconButton>
          </div>
        ))}
        {questions.length < ROUND_QUESTIONS_MAX ? <Button type="button" size="sm" variant="ghost" startIcon={<Plus aria-hidden className="size-4" />} className="self-start" onClick={() => setQuestions((list) => [...list, { id: "", label: "", type: "text" }])}>Add question</Button> : null}
      </fieldset>
      <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
        <legend className="px-1 text-label text-ink">Raise help automatically</legend>
        <p className="text-caption text-ink-muted">When an answer matches, the team gets a follow-up request in that category (once per round; skipped when the category is full).</p>
        {rules.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Dropdown aria-label="Question" value={r.questionId} onChange={(e) => editR(i, { questionId: e.target.value })} className="max-w-56">
              <option value="">Question…</option>
              {formSchema.map((q) => <option key={q.id} value={q.id}>{q.label || q.id}</option>)}
            </Dropdown>
            <Dropdown aria-label="Match" value={r.op} onChange={(e) => editR(i, { op: e.target.value as "eq" | "contains" })} className="max-w-36"><option value="eq">is</option><option value="contains">contains</option></Dropdown>
            <Input aria-label="Value" placeholder="yes, no or text" value={String(r.value)} onChange={(e) => editR(i, { value: e.target.value === "yes" ? true : e.target.value === "no" ? false : e.target.value })} className="max-w-40" />
            <Dropdown aria-label="Category" value={r.categoryKey} onChange={(e) => editR(i, { categoryKey: e.target.value })} className="max-w-48">
              <option value="">Category…</option>
              {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </Dropdown>
            <IconButton label="Remove rule" variant="danger" onClick={() => setRules((list) => list.filter((_, j) => j !== i))}><Trash2 aria-hidden className="size-4" /></IconButton>
          </div>
        ))}
        {rules.length < ROUND_TRIGGERS_MAX ? <Button type="button" size="sm" variant="ghost" startIcon={<Plus aria-hidden className="size-4" />} className="self-start" onClick={() => setRules((list) => [...list, { key: `rule-${list.length + 1}`, questionId: "", op: "eq", value: true, categoryKey: "" }])}>Add rule</Button> : null}
      </fieldset>
      <SwitchRow label="Fresh eyes across stages" description="Never assign a mentor to a team they mentored or visited in an earlier round. Off: avoided where possible." checked={acrossStages} onCheckedChange={setAcross} />
      <SwitchRow label="Allow revisits with a reason" description="Mentors normally visit a team only once across rounds." checked={freshOverride} onCheckedChange={setFreshOverride} />
      <SwitchRow label="Allow declared conflicts with a reason" description="Team members can never visit their own team." checked={conflictOverride} onCheckedChange={setConflictOverride} />
      <ErrorLine error={error} />
      <Button type="submit" variant="primary" loading={pending} className="self-start">{round ? "Save round" : "Add round"}</Button>
    </form>
  );
}
