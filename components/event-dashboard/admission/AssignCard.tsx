"use client";

import { useState } from "react";
import { applyReviewerAssignment, previewReviewerAssignment } from "@/app/actions/admission";
import type { AssignPreview } from "@/lib/admission/assignment";
import { Button } from "@/components/ui/button";
import { CheckboxField, Radio, RadioGroup } from "@/components/ui/choice";
import { Callout, Card, CardHeader } from "@/components/ui/display";
import { Dropdown, Field, Input } from "@/components/ui/field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { HelpLink } from "@/components/help/HelpLink";
import { useAdmissionAction, type AdmissionData, type AdmissionScope } from "./shared";

/**
 * Applications → Reviewers: assign a stage's applications to its reviewers.
 * Balanced spreads the work evenly in a fixed order; Random draws a seed you
 * can re-roll, and the same seed always gives the same plan. Preview changes
 * nothing; Apply is refused if anything changed since the preview.
 */
export function AssignCard({ scope, data }: { scope: AdmissionScope; data: AdmissionData }) {
  const { run, busy } = useAdmissionAction();
  const [stageId, setStageId] = useState(data.stages[0]?.id ?? "");
  const stage = data.stages.find((row) => row.id === stageId);
  const pool = data.reviewers.filter((row) => (stage?.panelUserIds.length ? stage.panelUserIds.includes(row.userId) : row.grantee));
  const [picked, setPicked] = useState<string[] | null>(null);
  const reviewerIds = picked ?? pool.map((row) => row.userId);
  const [perApplication, setPerApplication] = useState(String(stage?.reviewsPerApplication ?? 2));
  const [mode, setMode] = useState<"keep" | "replace">("keep");
  const [strategy, setStrategy] = useState<"balanced" | "random">("balanced");
  const [preview, setPreview] = useState<AssignPreview | null>(null);
  const names = new Map(data.reviewers.map((row) => [row.userId, row.name]));
  const input = (extra: Record<string, unknown> = {}) => ({ ...scope, stageId, perApplication: Number(perApplication), mode, strategy, reviewerIds, ...extra });

  return (
    <Card>
      <CardHeader title="Assign reviewers" description={stage ? `${stage.inReview} in review in ${stage.name}.` : "Add a stage first."} action={<HelpLink article="applications/stages-and-reviewers" />} />
      {pool.length === 0 ? <Callout tone="info" className="mt-3">This stage has no reviewers yet. Give co-organisers the Review applications permission, or choose a panel in Stages.</Callout> : null}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field label="Stage">
          <Dropdown value={stageId} onChange={(event) => { setStageId(event.target.value); setPicked(null); setPreview(null); }}>
            {data.stages.map((row) => <option key={row.id} value={row.id}>{row.position}. {row.name}</option>)}
          </Dropdown>
        </Field>
        <Field label="Reviewers per application"><Input type="number" min={1} max={20} value={perApplication} onChange={(event) => { setPerApplication(event.target.value); setPreview(null); }} /></Field>
        <Field label="How">
          <RadioGroup value={strategy} onValueChange={(value) => { setStrategy(value as "balanced" | "random"); setPreview(null); }}>
            <Radio value="balanced" label="Balanced" description="Even workloads, the same plan every time." />
            <Radio value="random" label="Random" description="Even workloads, shuffled with a seed you can re-roll." />
          </RadioGroup>
        </Field>
        <Field label="Existing assignments">
          <RadioGroup value={mode} onValueChange={(value) => { setMode(value as "keep" | "replace"); setPreview(null); }}>
            <Radio value="keep" label="Keep them and add more" />
            <Radio value="replace" label="Start over" description="Assignments already reviewed stay." />
          </RadioGroup>
        </Field>
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-2">
        {pool.map((row) => (
          <CheckboxField key={row.userId} label={row.name} checked={reviewerIds.includes(row.userId)} onCheckedChange={(checked) => { setPicked(checked ? [...reviewerIds, row.userId] : reviewerIds.filter((id) => id !== row.userId)); setPreview(null); }} />
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={!stage || reviewerIds.length === 0} loading={busy === "preview"} onClick={() => run("preview", () => previewReviewerAssignment(input()), null, (result) => result.ok && setPreview((result as { data: AssignPreview }).data))}>
          {preview?.strategy === "random" ? "Re-roll" : "Preview"}
        </Button>
        {preview ? (
          <Button variant="primary" loading={busy === "apply"} onClick={() => run("apply", () => applyReviewerAssignment(input({ fingerprint: preview.fingerprint, ...(preview.seed ? { seed: preview.seed } : {}) })), "Reviewers assigned.", (result) => result.ok && setPreview(null))}>
            Apply
          </Button>
        ) : null}
      </div>
      {preview ? (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-body-ui">{preview.covered} of {preview.applications} applications reach the target · {preview.added} to add · {preview.removed} to remove{preview.seed ? ` · seed ${preview.seed.slice(0, 8)}` : ""}</p>
          {preview.shortfalls.length ? <Callout tone="warning">{preview.shortfalls.length} {preview.shortfalls.length === 1 ? "application" : "applications"} can&apos;t reach the target with these reviewers (conflicts or too few people).</Callout> : null}
          <Table label="Reviewer workloads">
            <THead><TR><TH>Reviewer</TH><TH>Now</TH><TH>Added</TH><TH>Removed</TH><TH>After</TH></TR></THead>
            <TBody>
              {preview.loads.map((load) => (
                <TR key={load.reviewerId}><TD>{names.get(load.reviewerId) ?? "Reviewer"}</TD><TD>{load.before}</TD><TD>{load.added}</TD><TD>{load.removed}</TD><TD>{load.after}</TD></TR>
              ))}
            </TBody>
          </Table>
        </div>
      ) : null}
    </Card>
  );
}
