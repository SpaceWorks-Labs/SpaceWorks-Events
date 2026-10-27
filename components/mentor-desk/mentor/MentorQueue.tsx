"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout, Chip, EmptyState } from "@/components/ui/display";
import { Dropdown, Input, Textarea } from "@/components/ui/field";
import { mentorCommentOnHelp, mentorHelpCommand, mentorRaiseHelp } from "@/app/actions/mentor-console";
import type { MentorConsoleView } from "@/lib/core/mentorDesk/readsMentor";
import { HELP_COMMENT_MAX_LENGTH, HELP_SUMMARY_MAX_LENGTH } from "@/lib/mentorDesk/rules";
import { AutoRefresh, type DeskScope, ErrorLine, useDeskSave, When } from "../shared";

/**
 * My queue: one claim at a time. A claim is a lease (renew it while you
 * help); it lapses back to the queue if left. Requests a mentor cannot take
 * now (skills, conflicts, an assigned mentor's first five minutes) are shown
 * greyed out.
 */
export function MentorQueue({ scope, view }: { scope: DeskScope; view: MentorConsoleView }) {
  const { pending, error, save } = useDeskSave();
  const command = (requestId: string, version: number, action: string, extra: Record<string, unknown> = {}, done = "Updated.") =>
    save(() => mentorHelpCommand({ ...scope, requestId, action, expectedVersion: version, ...extra }), done);
  return (
    <div className="flex flex-col gap-4">
      <AutoRefresh seconds={15} />
      {!view.onShift ? <Callout tone="warning">You are off shift. The queue opens to you during your availability windows (Profile).</Callout> : null}
      {view.claim ? <ClaimCard scope={scope} claim={view.claim} timeZone={view.timezone} /> : null}
      {view.queue.length === 0 ? <EmptyState title="Nobody is waiting">New requests appear here; the page refreshes every 15 seconds.</EmptyState> : (
        <ul className="flex flex-col gap-2">
          {view.queue.map((r) => (
            <li key={r.id} className={`flex flex-col gap-1.5 rounded-lg border border-line bg-panel p-3 ${r.eligible ? "" : "opacity-60"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-label text-ink">{r.who}</span>
                <span className="text-caption text-ink-muted">{r.category} · priority {r.priority}</span>
                {r.assignedToMe ? <Chip size="sm" tone="accent">Your team</Chip> : null}
              </div>
              <p className="whitespace-pre-wrap text-body-ui text-ink">{r.summary}</p>
              <p className="text-caption text-ink-muted">{r.location ? `${r.location} · ` : ""}Waiting since <When iso={r.createdAt} timeZone={view.timezone} /></p>
              <Button size="sm" variant="primary" className="self-start" disabled={!r.eligible || !view.onShift || Boolean(view.claim)} loading={pending} onClick={() => command(r.id, r.version, "claim", {}, "Claimed. Head over.")}>
                {r.eligible ? "Claim" : "Needs another mentor"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ErrorLine error={error} />
      <RaiseForTeam scope={scope} view={view} />
    </div>
  );
}

function ClaimCard({ scope, claim, timeZone }: { scope: DeskScope; claim: NonNullable<MentorConsoleView["claim"]>; timeZone: string }) {
  const { pending, error, save } = useDeskSave();
  const [body, setBody] = useState("");
  const command = (action: string, extra: Record<string, unknown> = {}, done = "Updated.") => save(() => mentorHelpCommand({ ...scope, requestId: claim.id, action, expectedVersion: claim.version, ...extra }), done);
  return (
    <section className="flex flex-col gap-2 rounded-lg border-2 border-primary bg-panel p-3" aria-label="Your current claim">
      <div className="flex flex-wrap items-center gap-2">
        <Chip size="sm" tone={claim.lapsed ? "danger" : "accent"}>{claim.lapsed ? "Claim lapsed" : "Your claim"}</Chip>
        <span className="text-label text-ink">{claim.who}</span>
        <span className="text-caption text-ink-muted">{claim.category} · until <When iso={claim.claimExpiresAt} timeZone={timeZone} /></span>
      </div>
      <p className="whitespace-pre-wrap text-body-ui text-ink">{claim.summary}</p>
      {claim.location ? <p className="text-caption text-ink-muted">{claim.location}</p> : null}
      {claim.comments.length ? (
        <ul className="flex flex-col gap-1 border-l-2 border-line pl-3">
          {claim.comments.map((c) => <li key={c.id} className="text-caption text-ink-secondary"><strong className="text-ink">{c.origin === "TEAM" ? "Team" : "Mentor"}:</strong> {c.body}</li>)}
        </ul>
      ) : null}
      {!claim.lapsed ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" loading={pending} onClick={() => command("resolve", {}, "Resolved. Thank you.")}>Resolved</Button>
            <Button size="sm" variant="secondary" loading={pending} onClick={() => command("renew", { claimId: claim.claimId, claimGeneration: claim.claimGeneration }, "More time.")}>More time</Button>
            <Button size="sm" variant="ghost" loading={pending} onClick={() => command("release", {}, "Back in the queue.")}>Release</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input aria-label="Comment" placeholder="Message the team" maxLength={HELP_COMMENT_MAX_LENGTH} value={body} onChange={(e) => setBody(e.target.value)} className="max-w-96" />
            <Button size="sm" variant="secondary" disabled={!body.trim()} loading={pending} onClick={() => save(() => mentorCommentOnHelp({ ...scope, requestId: claim.id, expectedVersion: claim.version, body }), "Sent.", () => setBody(""))}>Send</Button>
          </div>
        </>
      ) : <p className="text-caption text-ink-muted">This claim lapsed and goes back to the queue within a minute.</p>}
      <ErrorLine error={error} />
    </section>
  );
}

function RaiseForTeam({ scope, view }: { scope: DeskScope; view: MentorConsoleView }) {
  const { pending, error, save } = useDeskSave();
  const [teamId, setTeam] = useState("");
  const [categoryKey, setCategory] = useState(view.categories[0]?.key ?? "");
  const [summary, setSummary] = useState("");
  if (view.categories.length === 0) return null;
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-label text-ink">Raise a request for a team</summary>
      <div className="mt-3 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <Dropdown aria-label="Team" value={teamId} onChange={(e) => setTeam(e.target.value)} className="max-w-56">
            <option value="">Team…</option>
            {view.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Dropdown>
          <Dropdown aria-label="Category" value={categoryKey} onChange={(e) => setCategory(e.target.value)} className="max-w-56">
            {view.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </Dropdown>
        </div>
        <Textarea aria-label="What they need" rows={2} maxLength={HELP_SUMMARY_MAX_LENGTH} value={summary} onChange={(e) => setSummary(e.target.value)} />
        <Button size="sm" variant="secondary" className="self-start" disabled={!teamId || !summary.trim()} loading={pending} onClick={() => save(() => mentorRaiseHelp({ ...scope, teamId, categoryKey, summary }), "Request raised.", () => setSummary(""))}>Raise request</Button>
        <ErrorLine error={error} />
      </div>
    </details>
  );
}
