"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea, Dropdown } from "@/components/ui/field";
import { cancelHelpRequest, commentOnHelpRequest, raiseHelpRequest, rateHelpRequest } from "@/app/actions/mentor-help";
import type { ParticipantDeskView } from "@/lib/core/mentorDesk/readsParticipant";
import { HELP_COMMENT_MAX_LENGTH, HELP_LOCATION_MAX_LENGTH, HELP_SUMMARY_MAX_LENGTH } from "@/lib/mentorDesk/rules";
import { AutoRefresh, ErrorLine, HelpStatusChip, type ParticipantRef, useDeskSave, When } from "../shared";

type Request = ParticipantDeskView["requests"][number];

/**
 * "Get help": ask the event's mentors for help, follow the request, talk to
 * the mentor, cancel it, and rate it once resolved. Only the team (or the
 * solo registrant) sees its own requests.
 */
export function GetHelpCard({ deskRef, view }: { deskRef: ParticipantRef; view: ParticipantDeskView }) {
  const { pending, error, save } = useDeskSave();
  const [categoryKey, setCategory] = useState(view.categories[0]?.key ?? "");
  const [summary, setSummary] = useState("");
  const [location, setLocation] = useState("");
  const note = view.categories.find((c) => c.key === categoryKey)?.contactNote;
  const live = view.requests.some((r) => r.open);
  return (
    <section aria-labelledby="get-help" className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-4">
      {live ? <AutoRefresh seconds={20} /> : null}
      <h2 id="get-help" className="text-h4 text-ink">Get help from a mentor</h2>
      {view.categories.length === 0 ? <p className="text-body-ui text-ink-muted">The organisers have not opened any help categories yet.</p> : (
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save(() => raiseHelpRequest({ ...deskRef, categoryKey, summary, location }), "Request sent. A mentor will pick it up.", () => { setSummary(""); setLocation(""); }); }}>
          <Field label="What do you need help with?">
            <Dropdown value={categoryKey} onChange={(e) => setCategory(e.target.value)}>
              {view.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </Dropdown>
          </Field>
          {note ? <p className="text-caption text-ink-muted">{note}</p> : null}
          <Field label="Describe the problem" helperText="Only your team, the mentors and the organisers see this.">
            <Textarea rows={3} maxLength={HELP_SUMMARY_MAX_LENGTH} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </Field>
          <Field label="Where are you?" optional><Input maxLength={HELP_LOCATION_MAX_LENGTH} placeholder="e.g. Table 12" value={location} onChange={(e) => setLocation(e.target.value)} /></Field>
          <ErrorLine error={error} />
          <Button type="submit" variant="primary" className="self-start" disabled={!summary.trim()} loading={pending}>Ask for help</Button>
        </form>
      )}
      {view.requests.length ? (
        <ul className="flex flex-col gap-2">{view.requests.map((r) => <RequestItem key={r.id} deskRef={deskRef} request={r} timeZone={view.timezone} />)}</ul>
      ) : null}
    </section>
  );
}

function RequestItem({ deskRef, request, timeZone }: { deskRef: ParticipantRef; request: Request; timeZone: string }) {
  const { pending, error, save } = useDeskSave();
  const [body, setBody] = useState("");
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <HelpStatusChip status={request.status} />
        <span className="text-label text-ink">{request.category}</span>
        <span className="text-caption text-ink-muted"><When iso={request.createdAt} timeZone={timeZone} />{request.open ? <> · open until <When iso={request.deadline} timeZone={timeZone} /></> : null}</span>
      </div>
      <p className="whitespace-pre-wrap text-body-ui text-ink-secondary">{request.summary}</p>
      {request.comments.length ? (
        <ul className="flex flex-col gap-1 border-l-2 border-line pl-3">
          {request.comments.map((c) => <li key={c.id} className="text-caption text-ink-secondary"><strong className="text-ink">{c.origin === "TEAM" ? "You" : "Mentor"}:</strong> {c.body}</li>)}
        </ul>
      ) : null}
      {request.open ? (
        <div className="flex flex-wrap gap-2">
          <Input aria-label="Message" placeholder="Add a message" maxLength={HELP_COMMENT_MAX_LENGTH} value={body} onChange={(e) => setBody(e.target.value)} className="max-w-80" />
          <Button size="sm" variant="secondary" disabled={!body.trim()} loading={pending} onClick={() => save(() => commentOnHelpRequest({ ...deskRef, requestId: request.id, expectedVersion: request.version, body }), "Sent.", () => setBody(""))}>Send</Button>
          <Button size="sm" variant="ghost" loading={pending} onClick={() => save(() => cancelHelpRequest({ ...deskRef, requestId: request.id, expectedVersion: request.version }), "Request cancelled.")}>Cancel request</Button>
        </div>
      ) : null}
      {request.status === "RESOLVED" && request.rating === null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-caption text-ink-secondary">How did it go?</span>
          {[1, 2, 3, 4, 5].map((n) => <Button key={n} size="sm" variant="ghost" aria-label={`Rate ${n} out of 5`} loading={pending} onClick={() => save(() => rateHelpRequest({ ...deskRef, requestId: request.id, rating: n }), "Thanks for rating.")}>{n}</Button>)}
        </div>
      ) : request.rating ? <p className="text-caption text-ink-muted">You rated this {request.rating}/5.</p> : null}
      <ErrorLine error={error} />
    </li>
  );
}
