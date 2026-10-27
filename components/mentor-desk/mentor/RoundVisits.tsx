"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Callout, Chip, type ChipTone } from "@/components/ui/display";
import { CheckboxField } from "@/components/ui/choice";
import { Dropdown, Field, Input, Textarea } from "@/components/ui/field";
import { mentorVisitCommand } from "@/app/actions/mentor-console";
import type { MentorConsoleView } from "@/lib/core/mentorDesk/readsMentor";
import { type DeskScope, ErrorLine, useDeskSave } from "../shared";

type Round = NonNullable<MentorConsoleView["round"]>;
type Lease = Round["leases"][string];

const STATE: Record<string, { label: string; tone: ChipTone }> = {
  due: { label: "To visit", tone: "warning" },
  seen: { label: "Visited before", tone: "outline" },
  busy: { label: "Being visited", tone: "info" },
  done: { label: "Checked in", tone: "success" },
  conflict: { label: "Conflict", tone: "danger" },
};

/**
 * The live round's visit board. Claiming a team takes a ten-minute lease,
 * renewed by a heartbeat while the form is open. Fresh eyes: teams you
 * visited before and declared conflicts need the round's permission and a
 * reason. Nominations are private to organisers and never affect judging.
 */
export function RoundVisits({ scope, round }: { scope: DeskScope; round: Round }) {
  const { pending, error, save } = useDeskSave();
  const [reason, setReason] = useState<Record<string, string>>({});
  const mine = Object.entries(round.leases);
  if (!round.inPool) return <Callout tone="info">You are not in this round&apos;s mentor pool.</Callout>;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-caption text-ink-muted">{round.label}: one check-in per team. A visit you leave lapses after ten minutes.</p>
      {mine.map(([teamId, lease]) => <VisitForm key={teamId} scope={scope} round={round} teamId={teamId} teamName={round.board.find((t) => t.teamId === teamId)?.teamName ?? "Team"} lease={lease} />)}
      <ul className="flex flex-col gap-1.5">
        {round.board.map((team) => {
          const state = STATE[team.state]!;
          const needsReason = (team.state === "seen" && round.allowFreshEyesOverride) || (team.state === "conflict" && round.allowConflictOverride);
          const claimable = team.state === "due" || needsReason;
          return (
            <li key={team.teamId} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2">
              <span className="text-label text-ink">{team.teamName}</span>
              <Chip size="sm" tone={state.tone}>{state.label}</Chip>
              {claimable && !round.leases[team.teamId] && mine.length === 0 ? (
                <span className="ml-auto flex flex-wrap gap-1.5">
                  {needsReason ? <Input aria-label="Reason" placeholder="Reason (organisers see it)" maxLength={300} value={reason[team.teamId] ?? ""} onChange={(e) => setReason((r) => ({ ...r, [team.teamId]: e.target.value }))} className="max-w-56" /> : null}
                  <Button size="sm" variant="secondary" disabled={needsReason && !reason[team.teamId]?.trim()} loading={pending}
                    onClick={() => save(() => mentorVisitCommand({ ...scope, roundId: round.id, teamId: team.teamId, action: "claim", expectedVersion: round.version, overrideReason: reason[team.teamId] ?? "" }), "Visit started.")}>
                    Start visit
                  </Button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <ErrorLine error={error} />
    </div>
  );
}

const HEARTBEAT_MS = 4 * 60_000;

function VisitForm({ scope, round, teamId, teamName, lease }: { scope: DeskScope; round: Round; teamId: string; teamName: string; lease: Lease }) {
  const router = useRouter();
  const { pending, error, save } = useDeskSave();
  const [answers, setAnswers] = useState<Record<string, string | number | boolean>>({});
  const [away, setAway] = useState(false);
  const [nominate, setNominate] = useState(false);
  const { organisationSlug, eventId } = scope;
  const leaseRef = useRef(lease);
  useEffect(() => { leaseRef.current = lease; }, [lease]);
  // Heartbeat while the form is open. Restart-safe: each effect run has its own flag.
  useEffect(() => {
    let current = true;
    const timer = window.setInterval(async () => {
      const l = leaseRef.current;
      const result = await mentorVisitCommand({ organisationSlug, eventId, roundId: round.id, teamId, action: "heartbeat", expectedVersion: l.version, leaseId: l.leaseId, generation: l.generation });
      if (current && result.ok) router.refresh();
    }, HEARTBEAT_MS);
    return () => { current = false; window.clearInterval(timer); };
  }, [organisationSlug, eventId, round.id, teamId, router]);
  const base = { ...scope, roundId: round.id, teamId, expectedVersion: lease.version, leaseId: lease.leaseId, generation: lease.generation };
  const set = (id: string, value: string | number | boolean) => setAnswers((a) => ({ ...a, [id]: value }));
  return (
    <section className="flex flex-col gap-3 rounded-lg border-2 border-primary bg-panel p-3" aria-label={`Visit to ${teamName}`}>
      <h3 className="text-h4 text-ink">Visiting {teamName}</h3>
      <CheckboxField label="The team was away" checked={away} onCheckedChange={(v) => { setAway(v === true); if (v === true) setNominate(false); }} />
      {!away ? round.form.map((q) => (
        <Field key={q.id} label={q.label} optional={!q.required}>
          {q.type === "text" ? <Textarea rows={2} value={String(answers[q.id] ?? "")} onChange={(e) => set(q.id, e.target.value)} />
            : q.type === "rating" ? <Dropdown value={String(answers[q.id] ?? "")} onChange={(e) => set(q.id, Number(e.target.value))}><option value="">Choose…</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Dropdown>
              : q.type === "yesno" ? <Dropdown value={answers[q.id] === undefined ? "" : answers[q.id] ? "yes" : "no"} onChange={(e) => set(q.id, e.target.value === "yes")}><option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option></Dropdown>
                : <Dropdown value={String(answers[q.id] ?? "")} onChange={(e) => set(q.id, e.target.value)}><option value="">Choose…</option>{q.options?.map((o) => <option key={o} value={o}>{o}</option>)}</Dropdown>}
        </Field>
      )) : null}
      {!away ? <CheckboxField label="Nominate this team" description="A private signal for organisers; it never changes judging scores." checked={nominate} onCheckedChange={(v) => setNominate(v === true)} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={pending} onClick={() => save(() => mentorVisitCommand({ ...base, action: "submit", formVersion: round.formVersion, answers: away ? undefined : answers, away, nominate }), "Check-in saved.")}>Submit check-in</Button>
        <Button variant="ghost" loading={pending} onClick={() => save(() => mentorVisitCommand({ ...base, action: "release" }), "Visit released.")}>Leave without a check-in</Button>
      </div>
      <ErrorLine error={error} />
    </section>
  );
}
