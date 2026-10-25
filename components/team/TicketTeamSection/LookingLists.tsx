"use client";

import { Button } from "@/components/ui/button";
import { Avatar, Callout, Chip } from "@/components/ui/display";
import { SearchInput } from "@/components/ui/field";
import { ShowMoreFooter } from "../useCursorList";
import type { SeekerPanelState } from "./useSeekerPanel";

/** Teams looking for members, searchable, with "Ask to join". */
export function TeamsLookingList({ s }: { s: SeekerPanelState }) {
  const { teamList, pending, busyId, requestJoin } = s;
  return (
    <div className="mt-5 border-t border-line pt-5">
      <h3 className="text-label text-ink">
        Teams looking for members
        {!teamList.query.trim() && teamList.total > 0 ? <span className="font-normal text-ink-muted"> · {teamList.total}</span> : null}
      </h3>
      {teamList.total > 0 || teamList.items.length > 0 || teamList.query ? (
        <div className="mt-2">
          <label htmlFor="ticket-team-search" className="sr-only">Search teams by name</label>
          <SearchInput
            id="ticket-team-search"
            placeholder="Search team names"
            value={teamList.query}
            onChange={(e) => teamList.setQuery(e.target.value)}
            onClear={() => teamList.setQuery("")}
            autoComplete="off"
            maxLength={100}
            className="py-2 sm:text-sm"
          />
        </div>
      ) : null}
      {teamList.error ? <Callout tone="danger" role="alert" className="mt-2">{teamList.error}</Callout> : null}
      {teamList.loading === "replace" ? (
        <p role="status" className="mt-2 text-body-ui text-ink-muted">Searching…</p>
      ) : teamList.items.length === 0 ? (
        <p className="mt-2 text-body-ui text-ink-muted">
          {teamList.query.trim() ? "No teams match that search." : "No teams are looking for members right now."}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-line" id={teamList.listId} aria-busy={teamList.loading != null}>
          {teamList.items.map((team) => (
            <li key={team.id} className="flex items-center justify-between gap-3 py-2.5">
              <p className="min-w-0 text-body-ui text-ink">
                <span className="block truncate font-semibold">{team.name}</span>
                <span className="text-sm text-ink-muted">{team.maxSize != null ? `${team.size} of ${team.maxSize}` : team.size} members</span>
              </p>
              <Button
                variant="secondary"
                size="sm"
                disabled={pending || team.requested}
                loading={busyId === team.id}
                onClick={() => requestJoin(team)}
              >
                {team.requested ? "Requested" : "Ask to join"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {teamList.loading !== "replace" ? (
        <ShowMoreFooter
          shown={teamList.items.length}
          total={teamList.total}
          hasMore={teamList.nextCursor != null}
          loading={teamList.loading === "more"}
          onMore={teamList.loadMore}
        />
      ) : null}
    </div>
  );
}

/** The other seekers listed for this event, searchable. */
export function OtherSeekersList({ s }: { s: SeekerPanelState }) {
  const { seekerList } = s;
  return (
    <div className="mt-5 border-t border-line pt-5">
      <h3 className="text-label text-ink">
        Others looking for a team
        {!seekerList.query.trim() && seekerList.total > 0 ? <span className="font-normal text-ink-muted"> · {seekerList.total}</span> : null}
      </h3>
      {seekerList.total > 0 || seekerList.items.length > 0 || seekerList.query ? (
        <div className="mt-2">
          <label htmlFor="ticket-seeker-search" className="sr-only">Search by skill, headline or first name</label>
          <SearchInput
            id="ticket-seeker-search"
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
      {seekerList.loading === "replace" ? (
        <p role="status" className="mt-2 text-body-ui text-ink-muted">Searching…</p>
      ) : seekerList.items.length === 0 ? (
        <p className="mt-2 text-body-ui text-ink-muted">{seekerList.query.trim() ? "No one matches that search." : "No one else is listed yet."}</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-line" id={seekerList.listId} aria-busy={seekerList.loading != null}>
          {seekerList.items.map((seeker) => (
            <li key={seeker.id} className="flex min-w-0 items-start gap-3 py-2.5">
              <Avatar name={seeker.displayName} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-label text-ink">{seeker.displayName}</p>
                <p className="break-words text-sm text-ink-secondary">{seeker.headline}</p>
                {seeker.skills.length ? (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Skills">
                    {seeker.skills.map((skill) => <li key={skill}><Chip tone="outline" size="sm">{skill}</Chip></li>)}
                  </ul>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {seekerList.loading !== "replace" ? (
        <ShowMoreFooter
          shown={seekerList.items.length}
          total={seekerList.total}
          hasMore={seekerList.nextCursor != null}
          loading={seekerList.loading === "more"}
          onMore={seekerList.loadMore}
        />
      ) : null}
    </div>
  );
}
