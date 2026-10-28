"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/display";
import { SwitchRow } from "@/components/ui/choice";
import { Field, Input } from "@/components/ui/field";
import { saveHelpCategoryAction } from "@/app/actions/mentor-desk";
import type { DeskOrganiserView } from "@/lib/core/mentorDesk/readsOrganiser";
import { HELP_CLAIM_MINUTES, HELP_EXPIRY_MINUTES, HELP_OPEN_LIMIT, HELP_PRIORITY_MAX } from "@/lib/mentorDesk/rules";
import { type DeskScope, ErrorLine, splitTags, useDeskSave } from "../shared";

type Category = DeskOrganiserView["categories"][number];

/**
 * Mentors → Categories: what teams can ask for, with each category's queue
 * policy. Priority orders the queue; skill tags limit who may claim; the open
 * limit (1–10) caps a team's waiting requests; a claim lasts 1–60 minutes
 * (renewable) and a request expires after 15 minutes to 7 days, never after
 * the event ends. A key never changes once created.
 */
export function CategoriesEditor({ scope, categories }: { scope: DeskScope; categories: Category[] }) {
  return (
    <div className="flex flex-col gap-3">
      {categories.map((c) => (
        <details key={c.id} className="rounded-lg border border-line bg-panel p-3">
          <summary className="flex cursor-pointer flex-wrap items-center gap-2">
            <span className="text-label text-ink">{c.label}</span>
            <code className="text-caption text-ink-muted">{c.key}</code>
            {!c.active ? <Chip size="sm" tone="neutral">Hidden</Chip> : null}
            {c.skillTags.length ? <span className="text-caption text-ink-muted">{c.skillTags.join(" · ")}</span> : null}
          </summary>
          <div className="mt-3"><CategoryForm scope={scope} category={c} /></div>
        </details>
      ))}
      <section className="rounded-lg border border-line p-3">
        <h3 className="mb-2 text-h4 text-ink">New category</h3>
        <CategoryForm scope={scope} />
      </section>
    </div>
  );
}

function CategoryForm({ scope, category }: { scope: DeskScope; category?: Category }) {
  const { pending, error, save } = useDeskSave();
  const [key, setKey] = useState(category?.key ?? "");
  const [label, setLabel] = useState(category?.label ?? "");
  const [tags, setTags] = useState(category?.skillTags.join(", ") ?? "");
  const [priority, setPriority] = useState(String(category?.priority ?? 0));
  const [openLimit, setOpenLimit] = useState(String(category?.openLimit ?? 1));
  const [claimMinutes, setClaim] = useState(String(category?.claimMinutes ?? 10));
  const [expiryMinutes, setExpiry] = useState(String(category?.expiryMinutes ?? 240));
  const [contactNote, setContact] = useState(category?.contactNote ?? "");
  const [active, setActive] = useState(category?.active ?? true);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save(() => saveHelpCategoryAction({
          ...scope, ...(category ? { id: category.id } : {}), expectedVersion: category?.version ?? 0, key, label, skillTags: splitTags(tags),
          priority: Number(priority), openLimit: Number(openLimit), claimMinutes: Number(claimMinutes), expiryMinutes: Number(expiryMinutes), contactNote, active,
        }), category ? "Category saved." : "Category added.", () => { if (!category) { setKey(""); setLabel(""); setTags(""); } });
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Field label="Label"><Input value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} /></Field>
        <Field label="Key" helperText="Lowercase letters, numbers and hyphens."><Input value={key} disabled={Boolean(category)} pattern="[a-z0-9-]{1,40}" onChange={(e) => setKey(e.target.value)} /></Field>
      </div>
      <Field label="Skill tags" optional helperText="Separated by commas. Only mentors with one of them may claim (assigned mentors always may)."><Input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
      <div className="flex flex-wrap gap-2">
        <Field label="Priority"><Input type="number" min={0} max={HELP_PRIORITY_MAX} value={priority} onChange={(e) => setPriority(e.target.value)} className="max-w-24" /></Field>
        <Field label="Open per team"><Input type="number" min={HELP_OPEN_LIMIT.min} max={HELP_OPEN_LIMIT.max} value={openLimit} onChange={(e) => setOpenLimit(e.target.value)} className="max-w-24" /></Field>
        <Field label="Claim minutes"><Input type="number" min={HELP_CLAIM_MINUTES.min} max={HELP_CLAIM_MINUTES.max} value={claimMinutes} onChange={(e) => setClaim(e.target.value)} className="max-w-24" /></Field>
        <Field label="Expiry minutes"><Input type="number" min={HELP_EXPIRY_MINUTES.min} max={HELP_EXPIRY_MINUTES.max} value={expiryMinutes} onChange={(e) => setExpiry(e.target.value)} className="max-w-28" /></Field>
      </div>
      <Field label="Note to teams" optional helperText="Shown when they pick this category, e.g. where to find the organisers."><Input value={contactNote} maxLength={300} onChange={(e) => setContact(e.target.value)} /></Field>
      <SwitchRow label="Teams can choose it" checked={active} onCheckedChange={setActive} />
      <ErrorLine error={error} />
      <Button type="submit" variant="primary" loading={pending} className="self-start">{category ? "Save category" : "Add category"}</Button>
    </form>
  );
}
