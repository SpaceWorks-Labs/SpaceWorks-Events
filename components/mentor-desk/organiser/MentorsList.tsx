"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip, EmptyState } from "@/components/ui/display";
import { Dropdown, Input } from "@/components/ui/field";
import { setMentorConflictAsOrganiser } from "@/app/actions/mentor-desk";
import type { DeskOrganiserView } from "@/lib/core/mentorDesk/readsOrganiser";
import { ProfileForm } from "../ProfileForm";
import { type DeskScope, ErrorLine, useDeskSave } from "../shared";

/**
 * Mentors → Mentors: everyone holding the MENTOR grant (invited from
 * Settings → Co-organisers), their shift, load and profile, and conflicts.
 */
export function MentorsList({ scope, view }: { scope: DeskScope; view: DeskOrganiserView }) {
  if (view.mentors.length === 0) {
    return <EmptyState title="No mentors yet">Invite mentors from Settings → Co-organisers with the Mentor permission. They pass the authenticator check like other staff.</EmptyState>;
  }
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {view.mentors.map((mentor) => (
          <li key={mentor.userId} className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-label text-ink">{mentor.name}</span>
              <span className="text-caption text-ink-muted">{mentor.email}</span>
              <Chip size="sm" tone={mentor.onShift ? "success" : "neutral"}>{mentor.onShift ? "On shift" : "Off shift"}</Chip>
              {mentor.profile ? <Chip size="sm" tone="outline">{mentor.load} / {mentor.profile.maxActiveTeams} teams</Chip> : <Chip size="sm" tone="warning">No profile</Chip>}
              {mentor.profile?.showOnPage ? <Chip size="sm" tone="info">On event page</Chip> : null}
            </div>
            {mentor.profile?.skills.length ? <p className="text-caption text-ink-muted">{mentor.profile.skills.join(" · ")}</p> : null}
            {mentor.profile ? (
              <details>
                <summary className="cursor-pointer text-caption font-semibold text-ink-secondary">Edit profile</summary>
                <div className="mt-3">
                  <ProfileForm scope={scope} mentorUserId={mentor.userId} profile={mentor.profile} timeZone={view.settings.timezone} bounds={{ start: view.settings.eventStart, end: view.settings.eventEnd }} as="organiser" />
                </div>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      <ConflictForm scope={scope} view={view} />
    </div>
  );
}

function ConflictForm({ scope, view }: { scope: DeskScope; view: DeskOrganiserView }) {
  const { pending, error, save } = useDeskSave();
  const [mentorUserId, setMentor] = useState("");
  const [teamId, setTeam] = useState("");
  const [kind, setKind] = useState<"DECLARED" | "AFFILIATION">("AFFILIATION");
  const [reason, setReason] = useState("");
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <legend className="px-1 text-label text-ink">Conflicts of interest</legend>
      <p className="text-caption text-ink-muted">A conflicted mentor never gets the team&apos;s help, assignment or visit. With the Mentor Desk on, judges are also kept off teams they mentored or are conflicted with.</p>
      {view.conflicts.length ? (
        <ul className="flex flex-col gap-1">
          {view.conflicts.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 text-caption text-ink-secondary">
              <span className="text-ink">{c.mentorName}</span> · {c.teamName} · {c.kind === "AFFILIATION" ? "affiliation" : c.declaredByMentor ? "declared by the mentor" : "declared"}{c.reason ? ` · ${c.reason}` : ""}
              <Button size="sm" variant="ghost" loading={pending} onClick={() => save(() => setMentorConflictAsOrganiser({ ...scope, mentorUserId: c.mentorUserId, teamId: c.teamId, kind: c.kind, active: false, reason: c.reason, expectedVersion: c.version }), "Conflict cleared.")}>Clear</Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Dropdown aria-label="Mentor" value={mentorUserId} onChange={(e) => setMentor(e.target.value)} className="max-w-56">
          <option value="">Mentor…</option>
          {view.mentors.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
        </Dropdown>
        <Dropdown aria-label="Team" value={teamId} onChange={(e) => setTeam(e.target.value)} className="max-w-56">
          <option value="">Team…</option>
          {view.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Dropdown>
        <Dropdown aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as "DECLARED" | "AFFILIATION")} className="max-w-44">
          <option value="AFFILIATION">Affiliation</option>
          <option value="DECLARED">Declared</option>
        </Dropdown>
        <Input aria-label="Reason" placeholder="Reason (organisers only)" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className="max-w-64" />
        <Button size="sm" variant="secondary" disabled={!mentorUserId || !teamId} loading={pending} onClick={() => save(() => setMentorConflictAsOrganiser({ ...scope, mentorUserId, teamId, kind, active: true, reason, expectedVersion: 0 }), "Conflict recorded.", () => setReason(""))}>Record conflict</Button>
      </div>
      <ErrorLine error={error} />
    </fieldset>
  );
}
