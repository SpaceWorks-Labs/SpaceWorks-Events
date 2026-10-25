"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadTeamsPage } from "@/app/actions/team-admin";
import { useLoadMoreFocus } from "@/components/ui/use-load-more-focus";
import { viewParam, type ViewParams } from "@/lib/savedViews";
import { useInitialViewParams, useSyncViewToUrl } from "@/components/event-dashboard/views/useViewUrl";
import type { DashboardTeam, DashboardTeamsPage } from "@/lib/eventDashboard/teams";
import type { TeamStatusFilter } from "@/components/event-dashboard/guests/teamList";
import { SEARCH_DELAY_MS, type Member } from "./constants";

/**
 * The Teams view: filters synced with the address bar, the dialog targets,
 * and the server-paged team list.
 */
export function useTeamsView({ organisationSlug, eventId, initialPage }: { organisationSlug: string; eventId: string; initialPage: DashboardTeamsPage }) {
  // Filters live in the address bar (saved views): a link reopens the same view.
  const fromUrl = useInitialViewParams("GUESTS_TEAMS");
  const [status, setStatus] = useState<TeamStatusFilter>(viewParam(fromUrl, "status") as TeamStatusFilter);
  const [query, setQuery] = useState(viewParam(fromUrl, "q"));
  const [searchedQuery, setSearchedQuery] = useState(query.trim());
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchedQuery(query.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  const viewParams: ViewParams = {};
  if (status !== "all") viewParams.status = status;
  if (searchedQuery) viewParams.q = searchedQuery;
  useSyncViewToUrl("GUESTS_TEAMS", viewParams);
  const applyView = useCallback((params: ViewParams) => {
    setStatus(viewParam(params, "status") as TeamStatusFilter);
    setQuery(viewParam(params, "q"));
  }, []);
  const [declining, setDeclining] = useState<DashboardTeam | null>(null);
  const [deleting, setDeleting] = useState<DashboardTeam | null>(null);
  const [renaming, setRenaming] = useState<DashboardTeam | null>(null);
  const [moving, setMoving] = useState<{ member: Member; team: DashboardTeam } | null>(null);
  const [removing, setRemoving] = useState<{ member: Member; team: DashboardTeam } | null>(null);

  const [teams, setTeams] = useState<DashboardTeam[]>(initialPage.teams);
  const { listId: teamListId, beforeLoadMore } = useLoadMoreFocus(teams.length);
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage.nextCursor);
  // A view opened from the address bar isn't the server-rendered first page: it loads on mount.
  const [loadingList, setLoadingList] = useState<"replace" | "more" | null>(status === "all" && !query.trim() ? null : "replace");
  const [listError, setListError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const counts = initialPage.counts;
  const scope = { organisationSlug, eventId };

  // How many pages the current view holds, so a refresh after a change can
  // reload the same stretch instead of dropping pages added with "Load more".
  const pagesLoaded = useRef(1);

  const fetchPage = useCallback(
    async (view: { query: string; status: TeamStatusFilter }, cursor: string | null) => {
      const seq = ++requestSeq.current;
      setLoadingList(cursor ? "more" : "replace");
      setListError(null);
      const res = await loadTeamsPage({ organisationSlug, eventId, query: view.query.trim(), filter: view.status, cursor });
      if (seq !== requestSeq.current) return;
      setLoadingList(null);
      if (!res.ok || !res.data) {
        setListError(res.ok ? "Could not load teams." : res.error);
        return;
      }
      const page = res.data;
      setTeams((current) => (cursor ? [...current, ...page.teams.filter((team) => !current.some((other) => other.id === team.id))] : page.teams));
      setNextCursor(page.nextCursor);
      pagesLoaded.current = cursor ? pagesLoaded.current + 1 : 1;
    },
    [organisationSlug, eventId],
  );

  /** Re-read the first `pages` pages of a view in place (after a change). */
  const reloadPages = useCallback(
    async (view: { query: string; status: TeamStatusFilter }, pages: number) => {
      const seq = ++requestSeq.current;
      setListError(null);
      const collected: DashboardTeam[] = [];
      let cursor: string | null = null;
      let loaded = 0;
      do {
        const res = await loadTeamsPage({ organisationSlug, eventId, query: view.query.trim(), filter: view.status, cursor });
        if (seq !== requestSeq.current) return;
        if (!res.ok || !res.data) {
          setListError(res.ok ? "Could not load teams." : res.error);
          return;
        }
        for (const team of res.data.teams) if (!collected.some((other) => other.id === team.id)) collected.push(team);
        cursor = res.data.nextCursor;
        loaded += 1;
      } while (cursor && loaded < pages);
      setTeams(collected);
      setNextCursor(cursor);
      pagesLoaded.current = loaded;
    },
    [organisationSlug, eventId],
  );

  // A search or a filter fetches its first page (a search waits for typing
  // to pause; the unfiltered view uses the first page that came with the
  // panel). A refresh after a change (new `initialPage`) reloads as many
  // pages as were showing.
  const firstRun = useRef(true);
  const lastView = useRef({ query, status });
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      if (status === "all" && !query.trim()) return;
      const timer = window.setTimeout(() => void fetchPage({ query, status }, null), 0);
      return () => window.clearTimeout(timer);
    }
    const unfiltered = status === "all" && !query.trim();
    const viewChanged = lastView.current.query !== query || lastView.current.status !== status;
    lastView.current = { query, status };
    if (!viewChanged && pagesLoaded.current > 1) {
      void reloadPages({ query, status }, pagesLoaded.current);
      return;
    }
    const timer = window.setTimeout(() => {
      if (!unfiltered) {
        void fetchPage({ query, status }, null);
        return;
      }
      requestSeq.current += 1;
      pagesLoaded.current = 1;
      setLoadingList(null);
      setListError(null);
      setTeams(initialPage.teams);
      setNextCursor(initialPage.nextCursor);
    }, viewChanged && !unfiltered && query.trim() ? SEARCH_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
  }, [query, status, fetchPage, reloadPages, initialPage]);

  return {
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
  };
}
