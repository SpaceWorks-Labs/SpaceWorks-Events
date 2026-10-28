"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dropdown, Input } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/display";
import { organiserHelpCommand } from "@/app/actions/mentor-desk";
import type { DeskOrganiserView } from "@/lib/core/mentorDesk/readsOrganiser";
import { AutoRefresh, type DeskScope, ErrorLine, HelpStatusChip, useDeskSave, When } from "../shared";

type Request = DeskOrganiserView["requests"][number];

/**
 * Mentors → Queue: the live board, re-read every 15 seconds. Organisers
 * assign a waiting request to an on-shift mentor, release or resolve a
 * claim, and reopen a resolved request with a reason.
 */
export function QueueBoard({ scope, view }: { scope: DeskScope; view: DeskOrganiserView }) {
  const live = view.requests.filter((r) => r.status === "OPEN" || r.status === "CLAIMED");
  const closed = view.requests.filter((r) => r.status !== "OPEN" && r.status !== "CLAIMED").slice(0, 30);
  const onShift = view.mentors.filter((m) => m.onShift && m.profile);
  return (
    <div className="flex flex-col gap-4">
      <AutoRefresh seconds={15} />
      <p className="text-caption text-ink-muted">
        {live.length} live · {onShift.length} of {view.mentors.length} mentors on shift. The board refreshes every 15 seconds; lapsed claims return to the queue within a minute.
      </p>
      {live.length === 0 ? <EmptyState title="Nobody is waiting">New help requests appear here.</EmptyState> : (
        <ul className="flex flex-col gap-2">
          {live.map((request) => <QueueRow key={request.id} scope={scope} request={request} mentors={onShift} timeZone={view.settings.timezone} />)}
        </ul>
      )}
      {closed.length > 0 ? (
        <details className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer text-label text-ink">Recently closed ({closed.length})</summary>
          <ul className="mt-3 flex flex-col gap-2">
            {closed.map((request) => <QueueRow key={request.id} scope={scope} request={request} mentors={onShift} timeZone={view.settings.timezone} />)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function QueueRow({ scope, request, mentors, timeZone }: { scope: DeskScope; request: Request; mentors: DeskOrganiserView["mentors"]; timeZone: string }) {
  const { pending, error, save } = useDeskSave();
  const [mentor, setMentor] = useState("");
  const [reason, setReason] = useState("");
  const run = (action: string, extra: Record<string, unknown> = {}, done = "Updated.") =>
    save(() => organiserHelpCommand({ ...scope, requestId: request.id, action, expectedVersion: request.version, ...extra }), done);
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <HelpStatusChip status={request.status} lapsed={request.lapsed} />
        <span className="text-label text-ink">{request.who}</span>
        <span className="text-caption text-ink-muted">{request.category} · priority {request.priority} · {request.origin.toLowerCase()}</span>
      </div>
      <p className="whitespace-pre-wrap text-body-ui text-ink">{request.summary}</p>
      <p className="text-caption text-ink-muted">
        {request.location ? `${request.location} · ` : ""}Raised <When iso={request.createdAt} timeZone={timeZone} /> · Deadline <When iso={request.deadline} timeZone={timeZone} />
        {request.claimedBy ? ` · Claimed by ${request.claimedBy}` : ""}{request.rating ? ` · Rated ${request.rating}/5` : ""}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {request.status === "OPEN" || request.status === "CLAIMED" ? (
          <>
            <label className="sr-only" htmlFor={`assign-${request.id}`}>Assign to</label>
            <Dropdown id={`assign-${request.id}`} value={mentor} onChange={(e) => setMentor(e.target.value)} className="max-w-56">
              <option value="">Assign to a mentor…</option>
              {mentors.map((m) => <option key={m.userId} value={m.userId}>{m.name} ({m.load} teams)</option>)}
            </Dropdown>
            <Button size="sm" variant="secondary" disabled={!mentor} loading={pending} onClick={() => run("assign", { mentorUserId: mentor }, "Assigned.")}>Assign</Button>
          </>
        ) : null}
        {request.status === "CLAIMED" && !request.lapsed ? (
          <>
            <Button size="sm" variant="ghost" loading={pending} onClick={() => run("release", {}, "Returned to the queue.")}>Release</Button>
            <Button size="sm" variant="secondary" loading={pending} onClick={() => run("resolve", {}, "Resolved.")}>Resolve</Button>
          </>
        ) : null}
        {request.status === "RESOLVED" ? (
          <>
            <Input aria-label="Reason for reopening" placeholder="Why reopen?" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="max-w-64" />
            <Button size="sm" variant="secondary" disabled={!reason.trim()} loading={pending} onClick={() => run("reopen", { note: reason }, "Reopened.")}>Reopen</Button>
          </>
        ) : null}
      </div>
      <ErrorLine error={error} />
    </li>
  );
}
