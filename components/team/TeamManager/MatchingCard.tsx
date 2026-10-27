"use client";

import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader } from "@/components/ui/display";
import { SearchInput } from "@/components/ui/field";
import { SwitchRow } from "@/components/ui/choice";
import { ShowMoreFooter } from "../useCursorList";
import { PersonSummary } from "./PersonSummary";
import type { TeamManagerProps } from "./types";
import type { TeamManagerState } from "./useTeamManager";

/** Find teammates: the looking-for-members switch, requests, sent invitations and the seeker list. */
export function MatchingCard({ team, seekers, m }: { team: TeamManagerProps["team"]; seekers: TeamManagerProps["seekers"]; m: TeamManagerState }) {
  const { pending, toggleLooking, hasIncoming, incoming, full, busyId, respond, hasSent, sent, withdrawInvite, seekerList, invited, invite } = m;
  return (
    <Card as="section" aria-labelledby="team-matching">
      <CardHeader title={<span id="team-matching">Find teammates</span>} description="People registered on their own can ask to join teams that are looking for members." />
      <SwitchRow
        label="Looking for members"
        description="Show your team to people looking for a team at this event."
        checked={team.lookingForMembers}
        disabled={pending}
        onCheckedChange={toggleLooking}
      />

      {hasIncoming ? (
        <div className="mt-5 border-t border-line pt-5">
          <h3 className="text-label text-ink">
            Requests to join <span className="font-normal text-ink-muted">· {incoming.total}</span>
          </h3>
          {incoming.error ? <Callout tone="danger" role="alert" className="mt-2">{incoming.error}</Callout> : null}
          <ul className="mt-2 flex flex-col divide-y divide-line" id={incoming.listId}>
            {incoming.items.map((request) => (
              <li key={request.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
                <PersonSummary name={request.displayName} headline={request.headline} skills={request.skills} />
                <div className="flex shrink-0 gap-2">
                  <Button variant="primary" size="sm" disabled={full} loading={busyId === request.id} onClick={() => respond(request.id, true)}>Accept</Button>
                  <Button variant="secondary" size="sm" disabled={busyId === request.id} onClick={() => respond(request.id, false)}>Decline</Button>
                </div>
              </li>
            ))}
          </ul>
          <ShowMoreFooter
            shown={incoming.items.length}
            total={incoming.total}
            hasMore={incoming.nextCursor != null}
            loading={incoming.loading === "more"}
            onMore={incoming.loadMore}
          />
        </div>
      ) : null}

      {hasSent ? (
        <div className="mt-5 border-t border-line pt-5">
          <h3 className="text-label text-ink">
            Invitations you sent <span className="font-normal text-ink-muted">· {sent.total}</span>
          </h3>
          {sent.error ? <Callout tone="danger" role="alert" className="mt-2">{sent.error}</Callout> : null}
          <ul className="mt-2 flex flex-col divide-y divide-line" id={sent.listId}>
            {sent.items.map((request) => (
              <li key={request.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
                <PersonSummary name={request.displayName} headline={request.headline} skills={request.skills} />
                <Button variant="quiet" size="sm" loading={busyId === request.id} onClick={() => withdrawInvite(request.id)}>Withdraw</Button>
              </li>
            ))}
          </ul>
          <ShowMoreFooter
            shown={sent.items.length}
            total={sent.total}
            hasMore={sent.nextCursor != null}
            loading={sent.loading === "more"}
            onMore={sent.loadMore}
          />
        </div>
      ) : null}

      <div className="mt-5 border-t border-line pt-5">
        <h3 className="text-label text-ink">
          Looking for a team
          {seekers !== null && !seekerList.query.trim() && seekerList.total > 0 ? (
            <span className="font-normal text-ink-muted"> · {seekerList.total}</span>
          ) : null}
        </h3>
        {seekers !== null && (seekerList.total > 0 || seekerList.items.length > 0 || seekerList.query) ? (
          <div className="mt-2">
            <label htmlFor="team-seeker-search" className="sr-only">Search by skill, headline or first name</label>
            <SearchInput
              id="team-seeker-search"
              placeholder="Search skills, headline or first name"
              value={seekerList.query}
              onChange={(e) => seekerList.setQuery(e.target.value)}
              onClear={() => seekerList.setQuery("")}
              autoComplete="off"
              maxLength={100}
              className="py-2 sm:text-sm"
            />
          </div>
        ) : null}
        {seekerList.error ? <Callout tone="danger" role="alert" className="mt-2">{seekerList.error}</Callout> : null}
        {seekers === null ? (
          <p className="mt-1 text-body-ui text-ink-muted">{full ? "Your team is full." : "This list isn't available right now."}</p>
        ) : seekerList.loading === "replace" ? (
          <p role="status" className="mt-2 text-body-ui text-ink-muted">Searching…</p>
        ) : seekerList.items.length === 0 ? (
          <p className="mt-2 text-body-ui text-ink-muted">
            {/* Seekers with a pending invitation or request for this team are listed above, not here. */}
            {seekerList.query.trim()
              ? "No one matches that search."
              : hasIncoming
                ? "Everyone looking for a team already has an invitation or request with your team, listed above. Check back later."
                : hasSent
                  ? "Everyone looking for a team has already been invited. Check back later."
                  : "No one is looking for a team yet. Check back later."}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y divide-line" id={seekerList.listId} aria-busy={seekerList.loading != null}>
            {seekerList.items.map((seeker) => (
              <li key={seeker.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
                <PersonSummary name={seeker.displayName} headline={seeker.headline} skills={seeker.skills} />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={invited.has(seeker.id)}
                  loading={busyId === seeker.id}
                  onClick={() => invite(seeker)}
                >
                  {invited.has(seeker.id) ? "Invited" : "Invite"}
                  <span className="sr-only"> {seeker.displayName}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {seekers !== null && seekerList.loading !== "replace" ? (
          <ShowMoreFooter
            shown={seekerList.items.length}
            total={seekerList.total}
            hasMore={seekerList.nextCursor != null}
            loading={seekerList.loading === "more"}
            onMore={seekerList.loadMore}
          />
        ) : null}
      </div>
    </Card>
  );
}
