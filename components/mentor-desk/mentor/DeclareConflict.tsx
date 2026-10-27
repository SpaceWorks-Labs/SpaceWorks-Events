"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dropdown, Input } from "@/components/ui/field";
import { declareMentorConflict } from "@/app/actions/mentor-console";
import { type DeskScope, ErrorLine, useDeskSave } from "../shared";

/** A mentor declares a conflict with a team (they will not get its help, assignment or visits). */
export function DeclareConflict({ scope, teams, conflicts }: { scope: DeskScope; teams: Array<{ id: string; name: string }>; conflicts: Array<{ teamId: string; teamName: string; kind: string; reason: string }> }) {
  const { pending, error, save } = useDeskSave();
  const [teamId, setTeam] = useState("");
  const [reason, setReason] = useState("");
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <legend className="px-1 text-label text-ink">Conflicts of interest</legend>
      {conflicts.length ? (
        <ul className="flex flex-col gap-1">
          {conflicts.map((c) => (
            <li key={`${c.teamId}-${c.kind}`} className="flex items-center gap-2 text-caption text-ink-secondary">
              {c.teamName} · {c.kind === "DECLARED" ? "declared by you" : "affiliation (set by organisers)"}
              {c.kind === "DECLARED" ? <Button size="sm" variant="ghost" loading={pending} onClick={() => save(() => declareMentorConflict({ ...scope, teamId: c.teamId, kind: "DECLARED", active: false, reason: c.reason }), "Conflict cleared.")}>Clear</Button> : null}
            </li>
          ))}
        </ul>
      ) : <p className="text-caption text-ink-muted">None declared.</p>}
      <div className="flex flex-wrap gap-2">
        <Dropdown aria-label="Team" value={teamId} onChange={(e) => setTeam(e.target.value)} className="max-w-56">
          <option value="">Team…</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Dropdown>
        <Input aria-label="Reason" placeholder="Reason (organisers only)" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className="max-w-64" />
        <Button size="sm" variant="secondary" disabled={!teamId} loading={pending} onClick={() => save(() => declareMentorConflict({ ...scope, teamId, kind: "DECLARED", active: true, reason }), "Conflict declared.")}>Declare</Button>
      </div>
      <ErrorLine error={error} />
    </fieldset>
  );
}
