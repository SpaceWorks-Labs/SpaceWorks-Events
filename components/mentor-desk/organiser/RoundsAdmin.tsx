"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip, type ChipTone } from "@/components/ui/display";
import { CheckboxField } from "@/components/ui/choice";
import { setRoundMentorPoolAction, transitionMentoringRoundAction } from "@/app/actions/mentor-desk";
import type { DeskOrganiserView } from "@/lib/core/mentorDesk/readsOrganiser";
import { RoundForm } from "./RoundForm";
import { type DeskScope, ErrorLine, useDeskSave, When } from "../shared";

type Round = DeskOrganiserView["rounds"][number];

const STATUS: Record<string, { label: string; tone: ChipTone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  LIVE: { label: "Live", tone: "success" },
  CLOSED: { label: "Closed", tone: "outline" },
  SKIPPED: { label: "Skipped", tone: "outline" },
};

/**
 * Mentors → Rounds: mentoring stages for team check-in visits (never
 * judging). One round is live at a time. Each round has its own mentor pool
 * (none chosen: every mentor), its own form, and a private shortlist of
 * mentors' nominations, which never enters judging scores.
 */
export function RoundsAdmin({ scope, view }: { scope: DeskScope; view: DeskOrganiserView }) {
  const bounds = { start: view.settings.eventStart, end: view.settings.eventEnd };
  const categories = view.categories.filter((c) => c.active).map((c) => ({ key: c.key, label: c.label }));
  return (
    <div className="flex flex-col gap-3">
      {view.rounds.map((round) => <RoundCard key={round.id} scope={scope} round={round} view={view} categories={categories} bounds={bounds} />)}
      <section className="rounded-lg border border-line p-3">
        <h3 className="mb-2 text-h4 text-ink">New round</h3>
        <RoundForm scope={scope} categories={categories} bounds={bounds} />
      </section>
    </div>
  );
}

function RoundCard({ scope, round, view, categories, bounds }: { scope: DeskScope; round: Round; view: DeskOrganiserView; categories: Array<{ key: string; label: string }>; bounds: { start: string; end: string } }) {
  const { pending, error, save } = useDeskSave();
  const [pool, setPool] = useState<string[]>(round.pool);
  const status = STATUS[round.status] ?? STATUS.DRAFT!;
  const act = (action: "open" | "close" | "skip") => save(() => transitionMentoringRoundAction({ ...scope, roundId: round.id, action, expectedVersion: round.version }), action === "open" ? "Round is live." : "Round ended.");
  const editable = round.status === "DRAFT" || round.status === "LIVE";
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-h4 text-ink">{round.label}</h3>
        <Chip size="sm" tone={status.tone}>{status.label}</Chip>
        <span className="text-caption text-ink-muted"><When iso={round.opensAt} timeZone={view.settings.timezone} /> – <When iso={round.closesAt} timeZone={view.settings.timezone} /> · {round.checkIns} check-ins</span>
        <span className="ml-auto flex gap-1.5">
          {round.status === "DRAFT" ? <Button size="sm" variant="primary" loading={pending} onClick={() => act("open")}>Open</Button> : null}
          {round.status === "LIVE" ? <Button size="sm" variant="secondary" loading={pending} onClick={() => act("close")}>Close</Button> : null}
          {editable ? <Button size="sm" variant="ghost" loading={pending} onClick={() => act("skip")}>Skip</Button> : null}
        </span>
      </div>
      {editable ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-label text-ink">Mentor pool</legend>
          <p className="text-caption text-ink-muted">{pool.length === 0 ? "None chosen: every mentor takes part in this round." : `${pool.length} chosen: only they visit, and assignments for this round use only them.`}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {view.mentors.map((m) => (
              <CheckboxField key={m.userId} label={m.name} checked={pool.includes(m.userId)} onCheckedChange={(on) => setPool((list) => (on === true ? [...list, m.userId] : list.filter((id) => id !== m.userId)))} />
            ))}
          </div>
          <Button size="sm" variant="secondary" className="self-start" loading={pending} onClick={() => save(() => setRoundMentorPoolAction({ ...scope, roundId: round.id, mentorUserIds: pool }), "Pool saved.")}>Save pool</Button>
        </fieldset>
      ) : null}
      {round.shortlist.length ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-label text-ink">Mentor nominations (private shortlist)</h4>
          <p className="text-caption text-ink-muted">An advisory signal for organisers only. It never changes judging scores.</p>
          <ul className="flex flex-wrap gap-2">{round.shortlist.map((s) => <li key={s.teamId}><Chip size="sm" tone="highlight">{s.teamName} · {s.nominations}</Chip></li>)}</ul>
        </section>
      ) : null}
      {round.status === "DRAFT" ? (
        <details>
          <summary className="cursor-pointer text-caption font-semibold text-ink-secondary">Edit round</summary>
          <div className="mt-3"><RoundForm scope={scope} round={round} categories={categories} bounds={bounds} /></div>
        </details>
      ) : null}
      <ErrorLine error={error} />
    </article>
  );
}
