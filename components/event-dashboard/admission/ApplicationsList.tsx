"use client";

import { useMemo, useState } from "react";
import type { AdmissionDecisionOutcome, AdmissionStatus } from "@prisma/client";
import { draftApplicationDecisions, removeApplicationDecisions } from "@/app/actions/admission";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { Callout, Chip, EmptyState } from "@/components/ui/display";
import { Dropdown, Field, Input } from "@/components/ui/field";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { OUTCOME_LABELS, STATUS_LABELS } from "@/lib/admission/rules";
import { ApplicationDetail } from "./ApplicationDetail";
import { DecisionsBar } from "./DecisionsBar";
import { STATUS_TONES, useAdmissionAction, type AdmissionData, type AdmissionScope } from "./shared";

/**
 * Applications → Review and decide: every application with its stage,
 * counted reviews against the stage's target and mean score. Select some and
 * draft a decision; drafted decisions take effect only when the batch is
 * released (DecisionsBar), which checks reviews and offers again.
 */
export function ApplicationsList({ scope, data }: { scope: AdmissionScope; data: AdmissionData }) {
  const { run, busy } = useAdmissionAction();
  const [stageId, setStageId] = useState<string>("all");
  const [status, setStatus] = useState<AdmissionStatus | "all">("IN_REVIEW");
  const [selected, setSelected] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<AdmissionDecisionOutcome>("ADVANCE");
  const [override, setOverride] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => data.applications.filter((app) => (stageId === "all" || app.stageId === stageId) && (status === "all" || app.status === status)), [data.applications, stageId, status]);
  const allSelected = rows.length > 0 && rows.every((row) => selected.includes(row.id));
  const toggle = (id: string, on: boolean) => setSelected((current) => (on ? [...new Set([...current, id])] : current.filter((value) => value !== id)));
  const short = rows.filter((row) => selected.includes(row.id) && row.status === "IN_REVIEW" && row.counted < row.target).length;

  return (
    <div className="flex flex-col gap-4">
      <DecisionsBar scope={scope} data={data} />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Stage">
          <Dropdown value={stageId} onChange={(event) => setStageId(event.target.value)}>
            <option value="all">Every stage</option>
            {data.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.position}. {stage.name}</option>)}
          </Dropdown>
        </Field>
        <Field label="Status">
          <Dropdown value={status} onChange={(event) => setStatus(event.target.value as AdmissionStatus | "all")}>
            <option value="all">Any status</option>
            {(Object.keys(STATUS_LABELS) as AdmissionStatus[]).map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
          </Dropdown>
        </Field>
      </div>
      {data.truncated ? <Callout tone="info">Showing the first 500 applications.</Callout> : null}
      {rows.length === 0 ? (
        <EmptyState title="No applications here">Applications appear as people register for the event.</EmptyState>
      ) : (
        <Table label="Applications">
          <THead>
            <TR>
              <TH className="w-10"><Checkbox aria-label="Select all shown" checked={allSelected} onCheckedChange={(checked) => setSelected(checked ? rows.map((row) => row.id) : [])} /></TH>
              <TH>Applicant</TH>
              <TH>Status</TH>
              <TH>Stage</TH>
              <TH>Reviews</TH>
              <TH>Score</TH>
              <TH>Drafted</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.id}>
                <TD><Checkbox aria-label={`Select ${row.name}`} checked={selected.includes(row.id)} onCheckedChange={(checked) => toggle(row.id, checked === true)} /></TD>
                <TD>
                  <button type="button" className="text-left font-semibold text-ink underline-offset-4 hover:underline" aria-expanded={open === row.id} onClick={() => setOpen(open === row.id ? null : row.id)}>
                    {row.name}
                  </button>
                  {row.teamSize != null ? <span className="block text-caption text-ink-muted">Team of {row.teamSize}</span> : null}
                  {open === row.id ? <ApplicationDetail scope={scope} application={row} stages={data.stages} reviewers={data.reviewers} /> : null}
                </TD>
                <TD><Chip tone={STATUS_TONES[row.status]} size="sm">{STATUS_LABELS[row.status]}</Chip></TD>
                <TD>{row.stageName ?? "–"}</TD>
                <TD>{row.status === "IN_REVIEW" ? `${row.counted} / ${row.target}` : "–"}</TD>
                <TD>{row.mean ?? "–"}</TD>
                <TD>{row.draft ? <Chip tone={row.draft.stale ? "warning" : "outline"} size="sm">{row.draft.stale ? "Changed, draft again" : OUTCOME_LABELS[row.draft.outcome]}</Chip> : null}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {selected.length ? (
        <div className="flex flex-col gap-3 rounded-[10px] border border-line bg-panel p-4">
          <p className="text-label text-ink">{selected.length} selected</p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Decision">
              <Dropdown value={outcome} onChange={(event) => setOutcome(event.target.value as AdmissionDecisionOutcome)}>
                {(Object.keys(OUTCOME_LABELS) as AdmissionDecisionOutcome[]).map((value) => <option key={value} value={value}>{OUTCOME_LABELS[value]}</option>)}
              </Dropdown>
            </Field>
            <Field label="Override reason" optional helperText={short ? `${short} selected ${short === 1 ? "is" : "are"} short of reviews: give a reason to decide anyway.` : "Only needed when an application is short of reviews."}>
              <Input value={override} maxLength={500} onChange={(event) => setOverride(event.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={busy === "draft"} onClick={() => run("draft", () => draftApplicationDecisions({ ...scope, applicationIds: selected, outcome, overrideReason: override.trim() || null }), (value) => `Drafted ${(value as { drafted: number }).drafted}. Release the batch to send them.`, (result) => result.ok && setSelected([]))}>
              Draft decision
            </Button>
            <Button variant="secondary" loading={busy === "undraft"} onClick={() => run("undraft", () => removeApplicationDecisions({ ...scope, applicationIds: selected }), "Removed from the draft.")}>Remove from draft</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
