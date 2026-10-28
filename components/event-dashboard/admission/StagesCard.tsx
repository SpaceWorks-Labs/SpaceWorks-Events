"use client";

import { useState } from "react";
import { createApplicationStage, deleteApplicationStage, setApplicationStagePanel, updateApplicationStage } from "@/app/actions/admission";
import { Button } from "@/components/ui/button";
import { CheckboxField, SwitchRow } from "@/components/ui/choice";
import { Callout, Card, CardHeader, Chip } from "@/components/ui/display";
import { Dropdown, Field, Input, Textarea } from "@/components/ui/field";
import { HelpLink } from "@/components/help/HelpLink";
import { useAdmissionAction, type AdmissionData, type AdmissionScope, type StageRow } from "./shared";

/**
 * Applications → Stages: each stage's settings and its own reviewer panel.
 * Stage 1 takes every application; later stages take the ones advanced into
 * them. A panel left empty means every Review applications collaborator.
 */
export function StagesCard({ scope, data }: { scope: AdmissionScope; data: AdmissionData }) {
  const { run, busy } = useAdmissionAction();
  return (
    <div className="flex flex-col gap-5">
      {data.stages.map((stage) => <StageEditor key={stage.id} scope={scope} stage={stage} data={data} last={stage.position === data.stages.length} />)}
      <Card>
        <CardHeader title="Add a stage" description="A new last stage, for example a shortlist or an interview. Applications reach it when you advance them." action={<HelpLink article="applications/stages-and-reviewers" />} />
        <Button className="mt-3" loading={busy === "add"} onClick={() => run("add", () => createApplicationStage({ ...scope, stage: { name: `Stage ${data.stages.length + 1}`, reviewsPerApplication: 1, blindReview: false, criteria: [], guidance: "", opensAt: null, closesAt: null } }), "Stage added.")}>
          Add stage
        </Button>
      </Card>
    </div>
  );
}

function StageEditor({ scope, stage, data, last }: { scope: AdmissionScope; stage: StageRow; data: AdmissionData; last: boolean }) {
  const { run, busy } = useAdmissionAction();
  const [name, setName] = useState(stage.name);
  const [status, setStatus] = useState(stage.status);
  const [target, setTarget] = useState(String(stage.reviewsPerApplication));
  const [blind, setBlind] = useState(stage.blindReview);
  const [criteria, setCriteria] = useState(stage.criteria.join("\n"));
  const [guidance, setGuidance] = useState(stage.guidance);
  const [panel, setPanel] = useState<string[]>(stage.panelUserIds);
  const key = (suffix: string) => `${stage.id}:${suffix}`;

  return (
    <Card>
      <CardHeader
        title={`${stage.position}. ${stage.name}`}
        titleAs="h3"
        description={`${stage.entries} reached this stage · ${stage.inReview} in review here · ${stage.poolSize} ${stage.poolSize === 1 ? "reviewer" : "reviewers"}`}
        action={<Chip tone={stage.status === "OPEN" ? "success" : "neutral"}>{stage.status === "OPEN" ? "Open" : stage.status === "DRAFT" ? "Draft" : "Closed"}</Chip>}
      />
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const list = criteria.split("\n").map((line) => line.trim()).filter(Boolean);
          run(key("save"), () => updateApplicationStage({ ...scope, stageId: stage.id, status, stage: { name, reviewsPerApplication: Number(target), blindReview: blind, criteria: list, guidance, opensAt: null, closesAt: null } }), "Stage saved.");
        }}
      >
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Name"><Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="Status" helperText="Reviewers review only while a stage is open.">
            <Dropdown value={status} onChange={(event) => setStatus(event.target.value as StageRow["status"])}>
              <option value="DRAFT">Draft</option>
              <option value="OPEN">Open</option>
              <option value="CLOSED">Closed</option>
            </Dropdown>
          </Field>
          <Field label="Reviews per application" helperText="Needed before a decision is released without an override.">
            <Input type="number" min={1} max={20} value={target} onChange={(event) => setTarget(event.target.value)} />
          </Field>
        </div>
        <SwitchRow label="Blind review" description="Reviewers don't see names, email addresses, phone numbers or team names." checked={blind} onCheckedChange={setBlind} />
        <Field label="Criteria" optional helperText="One per line, up to 10. Each is scored 1 to 5. Leave empty for one overall score.">
          <Textarea rows={3} value={criteria} onChange={(event) => setCriteria(event.target.value)} />
        </Field>
        <Field label="Guidance for reviewers" optional><Textarea rows={3} maxLength={2000} value={guidance} onChange={(event) => setGuidance(event.target.value)} /></Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy === key("save")}>Save stage</Button>
          {last && stage.position > 1 ? <Button type="button" variant="secondary" loading={busy === key("delete")} onClick={() => run(key("delete"), () => deleteApplicationStage({ ...scope, stageId: stage.id }), "Stage deleted.")}>Delete stage</Button> : null}
        </div>
      </form>
      <div className="mt-6 border-t border-line pt-4">
        <h4 className="text-label text-ink">Reviewer panel</h4>
        {data.reviewers.length === 0 ? (
          <Callout tone="info" className="mt-2">Nobody can review yet. In <strong>Settings</strong>, invite co-organisers with the <strong>Review applications</strong> permission.</Callout>
        ) : (
          <>
            <p className="mt-1 text-caption text-ink-muted">{panel.length === 0 ? "No panel chosen: everyone with the Review applications permission reviews this stage." : `${panel.length} chosen. Only they review this stage.`}</p>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {data.reviewers.map((reviewer) => (
                <CheckboxField
                  key={reviewer.userId}
                  label={`${reviewer.name}${reviewer.admin && !reviewer.grantee ? " (organiser)" : ""}`}
                  checked={panel.includes(reviewer.userId)}
                  onCheckedChange={(checked) => setPanel((current) => (checked ? [...current, reviewer.userId] : current.filter((id) => id !== reviewer.userId)))}
                />
              ))}
            </div>
            <Button className="mt-3" variant="secondary" loading={busy === key("panel")} onClick={() => run(key("panel"), () => setApplicationStagePanel({ ...scope, stageId: stage.id, userIds: panel }), "Panel saved.")}>Save panel</Button>
          </>
        )}
      </div>
    </Card>
  );
}
