"use client";

import { useState } from "react";
import { Dices } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, EmptyState } from "@/components/ui/display";
import { CheckboxField } from "@/components/ui/choice";
import { Dropdown } from "@/components/ui/field";
import { applyMentorAssignments, assignMentorManuallyAction, previewMentorAssignments, transitionMentorAssignment } from "@/app/actions/mentor-desk";
import type { AssignmentPreview } from "@/lib/core/mentorDesk/assignments";
import type { DeskOrganiserView } from "@/lib/core/mentorDesk/readsOrganiser";
import { type DeskScope, ErrorLine, useDeskSave } from "../shared";

const MODES = [
  { value: "SKILL_MATCH", label: "Skill match", hint: "Most shared skills first, then the lightest load." },
  { value: "ROUND_ROBIN", label: "Round robin", hint: "The lightest load first." },
  { value: "RANDOM", label: "Random", hint: "A seeded draw: the same seed always gives the same result." },
] as const;

/**
 * Mentors → Assignments: event-wide or per round (stage). Preview writes
 * nothing; Apply records the run, its seed and the teams left uncovered.
 * Conflicts, team membership, capacity and the round's pool always apply;
 * teams already mapped in the scope are skipped, and mentors outside their
 * availability are left out unless the organiser includes them.
 */
export function AssignmentsPanel({ scope, view }: { scope: DeskScope; view: DeskOrganiserView }) {
  const { pending, error, save } = useDeskSave();
  const [roundId, setRoundId] = useState("");
  const [mode, setMode] = useState<(typeof MODES)[number]["value"]>("SKILL_MATCH");
  const [proposed, setProposed] = useState(false);
  const [includeOffShift, setIncludeOffShift] = useState(false);
  const [preview, setPreview] = useState<AssignmentPreview | null>(null);
  const scopeInput = { ...scope, roundId: roundId || null };
  const runPreview = (seed?: string) => save(() => previewMentorAssignments({ ...scopeInput, mode, includeOffShift, ...(seed ? { seed } : {}) }), "", (r) => setPreview("data" in r ? (r.data as AssignmentPreview) : null));
  const roundLabel = (id: string | null) => (id ? view.rounds.find((r) => r.id === id)?.label ?? "Round" : "Event-wide");
  const live = view.assignments.filter((a) => a.status !== "ENDED" && (a.roundId ?? "") === roundId);
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-lg border border-line p-3">
        <h3 className="text-h4 text-ink">Assign mentors to teams</h3>
        <div className="flex flex-wrap gap-2">
          <Dropdown aria-label="Scope" value={roundId} onChange={(e) => { setRoundId(e.target.value); setPreview(null); }} className="max-w-60">
            <option value="">Event-wide</option>
            {view.rounds.map((r) => <option key={r.id} value={r.id}>{r.label}{r.pool.length ? ` (${r.pool.length} in pool)` : " (all mentors)"}</option>)}
          </Dropdown>
          <Dropdown aria-label="Mode" value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setPreview(null); }} className="max-w-48">
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Dropdown>
          <Button variant="secondary" loading={pending} onClick={() => runPreview()}>Preview</Button>
        </div>
        <p className="text-caption text-ink-muted">{MODES.find((m) => m.value === mode)?.hint}</p>
        <CheckboxField label="Include mentors outside their availability right now" checked={includeOffShift} onCheckedChange={(v) => { setIncludeOffShift(v === true); setPreview(null); }} />
        {preview ? (
          <div className="flex flex-col gap-2">
            {preview.seed ? (
              <div className="flex flex-wrap items-center gap-2 text-caption text-ink-muted">
                Seed <code className="rounded bg-muted px-1.5 py-0.5 text-ink">{preview.seed}</code>
                <Button size="sm" variant="ghost" startIcon={<Dices aria-hidden className="size-4" />} loading={pending} onClick={() => runPreview()}>Re-roll</Button>
              </div>
            ) : null}
            <ul className="flex flex-col divide-y divide-line">
              {preview.assignments.map((a) => <li key={a.teamId} className="flex justify-between gap-3 py-1.5 text-body-ui"><span className="text-ink">{a.teamName}</span><span className="text-ink-secondary">{a.mentorName}</span></li>)}
            </ul>
            {preview.uncovered.length ? <p className="text-caption text-warning-fg">Left uncovered: {preview.uncovered.map((u) => u.teamName).join(", ")}</p> : null}
            {preview.skipped.length ? <p className="text-caption text-ink-muted">Skipped, already assigned here: {preview.skipped.map((u) => u.teamName).join(", ")}</p> : null}
            <CheckboxField label="Propose only (activate each one later)" checked={proposed} onCheckedChange={(v) => setProposed(v === true)} />
            <Button variant="primary" className="self-start" loading={pending} disabled={preview.assignments.length === 0}
              onClick={() => save(() => applyMentorAssignments({ ...scopeInput, mode: preview.mode, seed: preview.seed ?? undefined, includeOffShift, fingerprint: preview.fingerprint, proposed }), "Assignments applied.", () => setPreview(null))}>
              Apply {preview.assignments.length} assignments
            </Button>
          </div>
        ) : null}
        <ErrorLine error={error} />
      </section>
      <ManualAssign scope={scope} view={view} roundId={roundId} />
      <section className="flex flex-col gap-2">
        <h3 className="text-h4 text-ink">{roundLabel(roundId || null)}: live assignments</h3>
        {live.length === 0 ? <EmptyState title="No live assignments">Preview and apply a run, or assign by hand.</EmptyState> : (
          <ul className="flex flex-col gap-1.5">{live.map((a) => <AssignmentRow key={a.id} scope={scope} row={a} />)}</ul>
        )}
      </section>
      {view.runs.length ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-h4 text-ink">Recent runs</h3>
          {view.runs.map((r) => <p key={r.id} className="text-caption text-ink-muted">{roundLabel(r.roundId)} · {r.mode.replace("_", " ").toLowerCase()} · {r.assigned} assigned, {r.uncovered} uncovered{r.seed ? ` · seed ${r.seed}` : ""}</p>)}
        </section>
      ) : null}
    </div>
  );
}

function AssignmentRow({ scope, row }: { scope: DeskScope; row: DeskOrganiserView["assignments"][number] }) {
  const { pending, error, save } = useDeskSave();
  const act = (action: "activate" | "end") => save(() => transitionMentorAssignment({ ...scope, assignmentId: row.id, action, expectedVersion: row.version }), action === "end" ? "Assignment ended." : "Assignment active.");
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2">
      <span className="text-label text-ink">{row.teamName}</span>
      <span className="text-body-ui text-ink-secondary">{row.mentorName}</span>
      <Chip size="sm" tone={row.status === "ACTIVE" ? "success" : "warning"}>{row.status === "ACTIVE" ? "Active" : "Proposed"}</Chip>
      {row.manualOverride ? <Chip size="sm" tone="outline">Hand edit</Chip> : null}
      <span className="ml-auto flex gap-1.5">
        {row.status === "PROPOSED" ? <Button size="sm" variant="secondary" loading={pending} onClick={() => act("activate")}>Activate</Button> : null}
        <Button size="sm" variant="ghost" loading={pending} onClick={() => act("end")}>End</Button>
      </span>
      <ErrorLine error={error} />
    </li>
  );
}

function ManualAssign({ scope, view, roundId }: { scope: DeskScope; view: DeskOrganiserView; roundId: string }) {
  const { pending, error, save } = useDeskSave();
  const [mentorUserId, setMentor] = useState("");
  const [teamId, setTeam] = useState("");
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <h3 className="text-h4 text-ink">Assign by hand</h3>
      <p className="text-caption text-ink-muted">Recorded as a hand edit. The same conflict and capacity checks apply.</p>
      <div className="flex flex-wrap gap-2">
        <Dropdown aria-label="Mentor" value={mentorUserId} onChange={(e) => setMentor(e.target.value)} className="max-w-56">
          <option value="">Mentor…</option>
          {view.mentors.filter((m) => m.profile).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
        </Dropdown>
        <Dropdown aria-label="Team" value={teamId} onChange={(e) => setTeam(e.target.value)} className="max-w-56">
          <option value="">Team…</option>
          {view.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Dropdown>
        <Button variant="secondary" disabled={!mentorUserId || !teamId} loading={pending} onClick={() => save(() => assignMentorManuallyAction({ ...scope, roundId: roundId || null, mentorUserId, teamId }), "Assigned.")}>Assign</Button>
      </div>
      <ErrorLine error={error} />
    </section>
  );
}
