"use client";

import { Download } from "lucide-react";
import { deleteTeam, rejectTeam, renameTeamAsOrganiser } from "@/app/actions/team-admin";
import { deleteRsvp } from "@/app/actions/rsvp-admin";
import { ConfirmationDialog } from "@/components/feedback/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import { Callout, EmptyState } from "@/components/ui/display";
import { SearchInput } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { teamExportSearchParams } from "@/lib/teamExport";
import { NO_SAVED_VIEWS, type SavedViewDto } from "@/lib/savedViews";
import { SavedViewsMenu } from "@/components/event-dashboard/views/SavedViewsMenu";
import type { DashboardTeamsPage } from "@/lib/eventDashboard/teams";
import { MoveToTeamDialog } from "@/components/event-dashboard/guests/MoveToTeamDialog";
import { TEAM_FILTERS } from "@/components/event-dashboard/guests/teamList";
import { RenameTeamDialog } from "./GuestsTeams/RenameTeamDialog";
import { TeamRow } from "./GuestsTeams/TeamRow";
import { useTeamActions } from "./GuestsTeams/useTeamActions";
import { useTeamsView } from "./GuestsTeams/useTeamsView";
import { HelpLink } from "@/components/help/HelpLink";

/**
 * Guests → Teams (docs/TEAMS.md). Teams are approved, declined and given a
 * place as one unit; members can be moved or removed one at a time. Every
 * action is re-checked on the server (organisation admin, team re-read with
 * its event, the event lock for capacity).
 *
 * The list is paged on the server: the first page comes with the panel, and
 * searches, status filters and "Load more" fetch bounded pages through
 * `loadTeamsPage`.
 */
export function GuestsTeams({
  organisationSlug,
  eventId,
  initialPage,
  approvalRequired,
  savedViews = NO_SAVED_VIEWS,
}: {
  organisationSlug: string;
  eventId: string;
  initialPage: DashboardTeamsPage;
  approvalRequired: boolean;
  /** Saved views for this list (the viewer's own and shared ones). */
  savedViews?: readonly SavedViewDto[];
}) {
  const { router, showToast, pending, busyId, run, withUndo } = useTeamActions(organisationSlug);
  const {
    status,
    setStatus,
    query,
    setQuery,
    viewParams,
    applyView,
    declining,
    setDeclining,
    deleting,
    setDeleting,
    renaming,
    setRenaming,
    moving,
    setMoving,
    removing,
    setRemoving,
    teams,
    teamListId,
    beforeLoadMore,
    nextCursor,
    loadingList,
    listError,
    counts,
    scope,
    fetchPage,
  } = useTeamsView({ organisationSlug, eventId, initialPage });

  // The CSV holds every team matching the chip and search showing, read on the server.
  const exportQuery = teamExportSearchParams({ status, query });
  const exportHref = `/api/exports/events/${eventId}/teams${exportQuery ? `?${exportQuery}` : ""}`;

  if (counts.all === 0 && teams.length === 0) {
    return (
      <EmptyState mood="sleepy" title="No teams yet.">
        Teams appear here when someone signs up and creates one.
      </EmptyState>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <h2 className="text-h4 text-ink">Teams</h2>
            <HelpLink article="guests/managing-teams" />
          </div>
          <p className="text-caption text-ink-muted">Each team counts as one place.{approvalRequired ? " Approve or decline a whole team at once." : null}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SavedViewsMenu surface="GUESTS_TEAMS" scope={scope} params={viewParams} onApply={applyView} initialViews={savedViews} />
          {counts[status] > 0 ? (
            <Button asChild variant="secondary" startIcon={<Download />}>
              <a href={exportHref} title="Export every team matching this filter and search">Export CSV</a>
            </Button>
          ) : (
            <Button variant="secondary" startIcon={<Download />} disabled title="No teams match this filter">
              Export CSV
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div role="group" aria-label="Filter teams by status" className="flex flex-wrap gap-1.5">
          {TEAM_FILTERS.map(({ value, label }) => {
            const on = status === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={on}
                onClick={() => setStatus(value)}
                className={cn(
                  "inline-flex min-h-[38px] items-center gap-2 rounded-full border px-3.5 text-sm font-semibold transition-colors",
                  on ? "border-primary bg-primary text-on-primary" : "border-line-strong bg-canvas text-ink hover:bg-subtle",
                )}
              >
                {label}
                <span className="opacity-75">{counts[value]}</span>
              </button>
            );
          })}
        </div>
        <div className="w-full min-w-0 sm:ml-auto sm:w-[260px]">
          <label htmlFor="team-search" className="sr-only">Search teams by name or member</label>
          <SearchInput
            id="team-search"
            placeholder="Search team or member"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClear={() => setQuery("")}
            autoComplete="off"
            className="py-2 sm:text-sm"
          />
        </div>
      </div>

      {listError ? <Callout tone="danger" role="alert">{listError}</Callout> : null}

      {loadingList === "replace" ? (
        <p role="status" className="text-body-ui text-ink-muted">Loading teams…</p>
      ) : teams.length === 0 ? (
        <EmptyState>{query.trim() ? "No teams match that search." : "No teams in this view."}</EmptyState>
      ) : (
        <ul id={teamListId} aria-label="Teams" aria-busy={loadingList != null} className="flex flex-col gap-2.5">
          {teams.map((team) => (
            <TeamRow
              key={team.id}
              team={team}
              pending={pending}
              busyId={busyId}
              scope={scope}
              run={run}
              setDeclining={setDeclining}
              setDeleting={setDeleting}
              setRenaming={setRenaming}
              setMoving={setMoving}
              setRemoving={setRemoving}
            />
          ))}
        </ul>
      )}

      {nextCursor && loadingList !== "replace" ? (
        <div className="flex justify-center">
          <Button variant="secondary" loading={loadingList === "more"} loadingLabel="Loading…" onClick={() => {
              beforeLoadMore();
              void fetchPage({ query, status }, nextCursor);
            }}>
            Load more teams
          </Button>
        </div>
      ) : null}

      <ConfirmationDialog
        open={declining != null}
        title="Decline this team?"
        message={`Everyone in ${declining?.name ?? "this team"} will be told they don't have a place.`}
        confirmLabel="Decline team"
        loading={pending}
        onCancel={() => setDeclining(null)}
        onConfirm={() => {
          if (!declining) return;
          const team = declining;
          setDeclining(null);
          run(team.id, () => rejectTeam({ ...scope, teamId: team.id }), `${team.name} declined`);
        }}
      />

      <ConfirmationDialog
        open={deleting != null}
        title="Delete this team?"
        message={`${deleting?.name ?? "This team"} and its ${deleting?.size === 1 ? "member's registration" : `${deleting?.size ?? 0} members' registrations`} will be removed. You can undo this for a few minutes.`}
        confirmLabel="Delete team"
        loading={pending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          const team = deleting;
          setDeleting(null);
          withUndo(team.id, () => deleteTeam({ ...scope, teamId: team.id }), `${team.name} deleted`, `${team.name} restored`);
        }}
      />

      <ConfirmationDialog
        open={removing != null}
        title="Remove from the event?"
        message={
          removing
            ? `${removing.member.name}'s registration will be removed from ${removing.team.name}.${
              removing.team.size <= 1
                ? " They're its only member, so the team is removed too; undo brings both back."
                : removing.member.isLeader
                  ? " Leadership passes to the longest-standing member."
                  : ""
            } You can undo this for a few minutes.`
            : ""
        }
        confirmLabel="Remove"
        loading={pending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          const { member, team } = removing;
          setRemoving(null);
          withUndo(team.id, () => deleteRsvp({ ...scope, rsvpId: member.rsvpId }), `${member.name} removed`, `${member.name} restored`);
        }}
      />

      {renaming ? (
        <RenameTeamDialog
          team={renaming}
          onClose={() => setRenaming(null)}
          onRename={async (name) => {
            const res = await renameTeamAsOrganiser({ ...scope, teamId: renaming.id, name });
            if (res.ok) {
              showToast("Team renamed", "success");
              router.refresh();
            }
            return res;
          }}
        />
      ) : null}

      {moving ? (
        <MoveToTeamDialog
          organisationSlug={organisationSlug}
          eventId={eventId}
          person={{ rsvpId: moving.member.rsvpId, name: moving.member.name, teamId: moving.team.id }}
          onClose={() => setMoving(null)}
          onMoved={() => router.refresh()}
        />
      ) : null}
    </div>
  );
}
