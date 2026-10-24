"use client";

import { useState } from "react";
import { loadRecentCheckIns } from "@/app/actions/checkin";
import type { useToast } from "@/components/feedback/ToastProvider";
import { useLoadMoreFocus } from "@/components/ui/use-load-more-focus";
import { appendRecentPage, mergeRecentFirstPage, type RecentList } from "@/lib/checkInRecentMerge";
import type { CheckInRecentRow } from "./types";

type RecentPage = { rows: CheckInRecentRow[]; nextCursor: string | null };

/**
 * Recent check-ins: the server's newest page plus any older pages loaded
 * with "Load more"; each refresh merges its new first page in at the top.
 */
export function useRecentCheckIns({
  organisationSlug,
  eventId,
  eventSlug,
  stationMode,
  recent,
  recentNextCursor,
  showToast,
}: {
  organisationSlug: string;
  eventId: string;
  eventSlug?: string;
  stationMode: boolean;
  recent: CheckInRecentRow[];
  recentNextCursor: string | null;
  showToast: ReturnType<typeof useToast>["showToast"];
}) {
  const [recentList, setRecentList] = useState<RecentList<CheckInRecentRow> & { source: CheckInRecentRow[] }>(() => ({ source: recent, rows: recent, cursor: recentNextCursor }));
  if (recentList.source !== recent) {
    setRecentList({ source: recent, ...mergeRecentFirstPage(recentList, { rows: recent, nextCursor: recentNextCursor }) });
  }
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The phone list and the wider table show the same rows; only the visible one takes focus.
  const listFocus = useLoadMoreFocus(recentList.rows.length);
  const tableFocus = useLoadMoreFocus(recentList.rows.length);

  const loadOlder = async () => {
    const cursor = recentList.cursor;
    if (!cursor || loadingOlder) return;
    listFocus.beforeLoadMore();
    tableFocus.beforeLoadMore();
    setLoadingOlder(true);
    try {
      let page: RecentPage | null = null;
      let error = "Could not load more check-ins.";
      if (stationMode) {
        const response = await fetch("/api/check-in/station", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ organisationSlug, eventSlug, action: "recent", cursor }) });
        const result = (await response.json()) as { ok: true; data: RecentPage } | { ok: false; error: string };
        if (result.ok) page = result.data;
        else error = result.error;
      } else {
        const result = await loadRecentCheckIns({ organisationSlug, eventId, cursor });
        if (result.ok && result.data) page = result.data;
        else if (!result.ok) error = result.error;
      }
      if (!page) {
        showToast(error, "error");
        return;
      }
      const loaded = page;
      // Ignore a page that arrives after a refresh restarted the list.
      setRecentList((current) => (current.cursor === cursor ? { ...current, ...appendRecentPage(current, loaded) } : current));
    } catch {
      showToast("Could not load more check-ins.", "error");
    } finally {
      setLoadingOlder(false);
    }
  };

  const removeRecent = (rsvpId: string) => setRecentList((current) => ({ ...current, rows: current.rows.filter((row) => row.rsvpId !== rsvpId) }));

  return { rows: recentList.rows, hasMore: Boolean(recentList.cursor), loadingOlder, loadOlder, removeRecent, listId: listFocus.listId, tableId: tableFocus.listId };
}

export type RecentCheckInsState = ReturnType<typeof useRecentCheckIns>;
