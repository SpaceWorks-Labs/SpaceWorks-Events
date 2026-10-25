"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadSubmissionsPage } from "@/app/actions/judging-admin";
import { useLoadMoreFocus } from "@/components/ui/use-load-more-focus";
import type { JudgingDashboardSubmission, JudgingDashboardSubmissionsPage } from "@/lib/eventDashboard/judging";
import type { JudgingScope } from "../JudgingPanelShared";
import { SEARCH_DELAY_MS, type Filter, type View } from "./types";

/** The server-paged project list for the current filter and search. */
export function useSubmissionsList({
  scope,
  initialPage,
  filter,
  query,
}: {
  scope: JudgingScope;
  initialPage: JudgingDashboardSubmissionsPage;
  filter: Filter;
  query: string;
}) {
  const [submissions, setSubmissions] = useState<JudgingDashboardSubmission[]>(initialPage.submissions);
  const loadMoreFocus = useLoadMoreFocus(submissions.length);
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage.nextCursor);
  // A view opened from the address bar isn't the server-rendered first page: it loads on mount.
  const [loadingList, setLoadingList] = useState<"replace" | "more" | null>(filter === "all" && !query.trim() ? null : "replace");
  const [listError, setListError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const { organisationSlug, eventId } = scope;
  // How many pages the current view holds, so a refresh after a change
  // reloads the same stretch instead of dropping pages added with "Load more".
  const pagesLoaded = useRef(1);

  const fetchPage = useCallback(
    async (view: View, cursor: string | null) => {
      const seq = ++requestSeq.current;
      setLoadingList(cursor ? "more" : "replace");
      setListError(null);
      const res = await loadSubmissionsPage({ organisationSlug, eventId, query: view.query.trim(), status: view.status, cursor });
      if (seq !== requestSeq.current) return;
      setLoadingList(null);
      if (!res.ok || !res.data) {
        setListError(res.ok ? "Could not load projects." : res.error);
        return;
      }
      const page = res.data;
      setSubmissions((current) => (cursor ? [...current, ...page.submissions.filter((row) => !current.some((other) => other.id === row.id))] : page.submissions));
      setNextCursor(page.nextCursor);
      pagesLoaded.current = cursor ? pagesLoaded.current + 1 : 1;
    },
    [organisationSlug, eventId],
  );

  /** Re-read the first `pages` pages of a view in place (after a change). */
  const reloadPages = useCallback(
    async (view: View, pages: number) => {
      const seq = ++requestSeq.current;
      setListError(null);
      const collected: JudgingDashboardSubmission[] = [];
      let cursor: string | null = null;
      let loaded = 0;
      do {
        const res = await loadSubmissionsPage({ organisationSlug, eventId, query: view.query.trim(), status: view.status, cursor });
        if (seq !== requestSeq.current) return;
        if (!res.ok || !res.data) {
          setListError(res.ok ? "Could not load projects." : res.error);
          return;
        }
        for (const row of res.data.submissions) if (!collected.some((other) => other.id === row.id)) collected.push(row);
        cursor = res.data.nextCursor;
        loaded += 1;
      } while (cursor && loaded < pages);
      setSubmissions(collected);
      setNextCursor(cursor);
      pagesLoaded.current = loaded;
    },
    [organisationSlug, eventId],
  );

  // A filter or a search fetches its first page (a search waits for typing to
  // pause; the unfiltered view uses the first page that came with the panel).
  // A refresh after a change (new `initialPage`) reloads the pages showing.
  const firstRun = useRef(true);
  const lastView = useRef<View>({ query, status: filter });
  useEffect(() => {
    // "Not submitted" lists entrants, not projects (JudgingUnsubmittedList loads its own pages).
    if (filter === "notSubmitted") {
      firstRun.current = false;
      lastView.current = { query, status: filter };
      return;
    }
    if (firstRun.current) {
      firstRun.current = false;
      if (filter === "all" && !query.trim()) return;
      const timer = window.setTimeout(() => void fetchPage({ query, status: filter }, null), 0);
      return () => window.clearTimeout(timer);
    }
    const view: View = { query, status: filter };
    const unfiltered = filter === "all" && !query.trim();
    const viewChanged = lastView.current.query !== query || lastView.current.status !== filter;
    lastView.current = view;
    if (!viewChanged && pagesLoaded.current > 1) {
      void reloadPages(view, pagesLoaded.current);
      return;
    }
    const timer = window.setTimeout(() => {
      if (!unfiltered) {
        void fetchPage(view, null);
        return;
      }
      requestSeq.current += 1;
      pagesLoaded.current = 1;
      setLoadingList(null);
      setListError(null);
      setSubmissions(initialPage.submissions);
      setNextCursor(initialPage.nextCursor);
    }, viewChanged && !unfiltered && query.trim() ? SEARCH_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
  }, [query, filter, fetchPage, reloadPages, initialPage]);

  return { submissions, loadMoreFocus, nextCursor, loadingList, listError, fetchPage };
}
