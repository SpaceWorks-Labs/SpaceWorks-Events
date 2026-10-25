"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadJudgeSubmissionsPage } from "@/app/actions/judging";
import type { JudgeSubmissionDto, JudgeSubmissionsPageDto } from "@/lib/judgingDto";
import type { JudgeSubmissionCounts, JudgeSubmissionFilter } from "@/lib/judgingPaging";
import type { ListView, Scope } from "./types";

const SEARCH_DELAY_MS = 300;

/** The judge's server-paged submission list: filter, search, pages and totals. */
export function useJudgeSubmissionsList({ organisationSlug, eventId, initialPage }: Scope & { initialPage: JudgeSubmissionsPageDto }) {
  const [filter, setFilter] = useState<JudgeSubmissionFilter>("all");
  const [query, setQuery] = useState("");
  const [submissions, setSubmissions] = useState<JudgeSubmissionDto[]>(initialPage.submissions);
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage.nextCursor);
  const [counts, setCounts] = useState<JudgeSubmissionCounts>(initialPage.counts);
  const [loadingList, setLoadingList] = useState<"replace" | "more" | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const listSeq = useRef(0);
  // How many pages the current view holds, so a refresh after a save reloads
  // the same stretch instead of dropping pages added with "Load more".
  const pagesLoaded = useRef(1);

  const fetchPage = useCallback(
    async (view: ListView, cursor: string | null) => {
      const seq = ++listSeq.current;
      setLoadingList(cursor ? "more" : "replace");
      setListError(null);
      const res = await loadJudgeSubmissionsPage({ organisationSlug, eventId, query: view.query.trim(), filter: view.filter, cursor });
      if (seq !== listSeq.current) return;
      setLoadingList(null);
      if (!res.ok || !res.data) {
        setListError(res.ok ? "Could not load submissions." : res.error);
        return;
      }
      const page = res.data;
      setSubmissions((current) => (cursor ? [...current, ...page.submissions.filter((row) => !current.some((other) => other.id === row.id))] : page.submissions));
      setNextCursor(page.nextCursor);
      setCounts(page.counts);
      pagesLoaded.current = cursor ? pagesLoaded.current + 1 : 1;
    },
    [organisationSlug, eventId],
  );

  /** Re-read the first `pages` pages of a view in place (after a save). */
  const reloadPages = useCallback(
    async (view: ListView, pages: number) => {
      const seq = ++listSeq.current;
      setListError(null);
      const collected: JudgeSubmissionDto[] = [];
      let cursor: string | null = null;
      let loaded = 0;
      let latestCounts: JudgeSubmissionCounts | null = null;
      do {
        const res = await loadJudgeSubmissionsPage({ organisationSlug, eventId, query: view.query.trim(), filter: view.filter, cursor });
        if (seq !== listSeq.current) return;
        if (!res.ok || !res.data) {
          setListError(res.ok ? "Could not load submissions." : res.error);
          return;
        }
        for (const row of res.data.submissions) if (!collected.some((other) => other.id === row.id)) collected.push(row);
        cursor = res.data.nextCursor;
        latestCounts = res.data.counts;
        loaded += 1;
      } while (cursor && loaded < pages);
      setSubmissions(collected);
      setNextCursor(cursor);
      if (latestCounts) setCounts(latestCounts);
      pagesLoaded.current = loaded;
    },
    [organisationSlug, eventId],
  );

  // A filter or search fetches its first page (a search waits for typing to
  // pause; the unfiltered view uses the first page that came with the panel).
  // A refresh after a save (new `initialPage`) reloads as many pages as were
  // showing, so a reviewed project leaves "To score" straight away.
  const firstRun = useRef(true);
  const lastView = useRef<ListView>({ query, filter });
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const unfiltered = filter === "all" && !query.trim();
    const viewChanged = lastView.current.query !== query || lastView.current.filter !== filter;
    lastView.current = { query, filter };
    if (!viewChanged && (pagesLoaded.current > 1 || !unfiltered)) {
      void reloadPages({ query, filter }, pagesLoaded.current);
      return;
    }
    const timer = window.setTimeout(() => {
      if (!unfiltered) {
        void fetchPage({ query, filter }, null);
        return;
      }
      listSeq.current += 1;
      pagesLoaded.current = 1;
      setLoadingList(null);
      setListError(null);
      setSubmissions(initialPage.submissions);
      setNextCursor(initialPage.nextCursor);
      setCounts(initialPage.counts);
    }, viewChanged && !unfiltered && query.trim() ? SEARCH_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
  }, [query, filter, fetchPage, reloadPages, initialPage]);

  return { filter, setFilter, query, setQuery, submissions, setSubmissions, nextCursor, counts, loadingList, listError, fetchPage };
}
