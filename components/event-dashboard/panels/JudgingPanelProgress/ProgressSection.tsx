"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { loadJudgingProgressPage } from "@/app/actions/judging-ops";
import { Callout, Card, CardHeader, EmptyState } from "@/components/ui/display";
import { PageNumberPager } from "@/components/ui/page-number-pager";
import { Spinner } from "@/components/ui/spinner";
import { TBody, THead, Table } from "@/components/ui/table";
import { numberedPageLabel, type NumberedPage } from "@/lib/judgingOrganiserPaging";
import type { JudgingProgressSection } from "@/lib/judgingProgress";
import type { JudgingScope } from "../JudgingPanelShared";

/**
 * One Progress list as numbered pages. The first page arrives with the
 * server render; other pages come from `loadJudgingProgressPage`. A refresh
 * after a change (a new `initial`) re-reads the page showing.
 */
export function ProgressSection<R>({
  scope,
  section,
  initial,
  title,
  description,
  noun,
  empty,
  head,
  renderRow,
  roundId = null,
}: {
  scope: JudgingScope;
  section: JudgingProgressSection;
  initial: NumberedPage<R>;
  title: string;
  description: string;
  noun: string;
  empty: string;
  head: ReactNode;
  renderRow: (row: R) => ReactNode;
  /** Another judging round than the current one (docs/HACKATHON.md "Rounds"). */
  roundId?: string | null;
}) {
  const [data, setData] = useState<NumberedPage<R>>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const pageRef = useRef(1);
  const headingId = `judging-progress-${section}`;

  const fetchPage = useCallback(
    async (page: number) => {
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      let res: Awaited<ReturnType<typeof loadJudgingProgressPage>>;
      try {
        res = await loadJudgingProgressPage({ ...scope, section, page, ...(roundId ? { roundId } : {}) });
      } catch {
        res = { ok: false, error: "Couldn't load the list. Try again." };
      }
      if (mine !== seq.current) return;
      setLoading(false);
      if (!res.ok || !res.data || res.data.section !== section) {
        setError(res.ok ? "Couldn't load the list. Try again." : res.error);
        return;
      }
      setData(res.data.page as unknown as NumberedPage<R>);
      pageRef.current = res.data.page.page;
    },
    [scope, section, roundId],
  );

  // A server refresh: show page 1 as rendered, or re-read the page showing.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      if (pageRef.current === 1) {
        seq.current += 1;
        setLoading(false);
        setError(null);
        setData(initial);
        return;
      }
      void fetchPage(pageRef.current);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initial, fetchPage]);

  return (
    <Card as="section" aria-labelledby={headingId}>
      <CardHeader title={<span id={headingId}>{title}</span>} description={description} />
      {data.total === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-caption text-ink-muted" role="status">
              {numberedPageLabel({ start: data.start, total: data.total, shown: data.rows.length }, noun)}
            </p>
            {loading ? <Spinner label="Loading" /> : null}
          </div>
          {error ? (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          ) : null}
          <Table label={title}>
            <THead>{head}</THead>
            <TBody>{data.rows.map(renderRow)}</TBody>
          </Table>
          <PageNumberPager label={`${title} pages`} page={data.page} totalPages={data.totalPages} disabled={loading} onPage={(page) => void fetchPage(page)} />
        </div>
      )}
    </Card>
  );
}
