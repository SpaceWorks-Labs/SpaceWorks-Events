"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { JudgingStatus } from "@prisma/client";
import { changeScoreNormalization, loadResultsPage } from "@/app/actions/judging-admin";
import { Button } from "@/components/ui/button";
import { FilterChip, SwitchRow } from "@/components/ui/choice";
import { Callout, Card, CardHeader, Chip, EmptyState } from "@/components/ui/display";
import { SearchInput } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { TBody, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { numberedPageLabel, RESULTS_SCORE_FILTERS, type ResultsScoreFilter } from "@/lib/judgingOrganiserPaging";
import { NO_SAVED_VIEWS, viewParam, type SavedViewDto, type ViewParams } from "@/lib/savedViews";
import { SavedViewsMenu } from "@/components/event-dashboard/views/SavedViewsMenu";
import { useInitialViewParams, useSyncViewToUrl } from "@/components/event-dashboard/views/useViewUrl";
import { judgingResultsExportHref } from "@/lib/judgingExport";
import type { JudgingDashboardCriterion, JudgingDashboardResultsPage } from "@/lib/eventDashboard/judging";
import { scoreMethodCopy } from "./judgingCopy";
import { PageNumberPager } from "@/components/ui/page-number-pager";
import { formatScore, useJudgingAction, type JudgingScope } from "./JudgingPanelShared";
import { PublishCard } from "./JudgingPanelResults/PublishCard";

export { JudgingPanelJudges } from "./JudgingPanelResults/Judges";

const SEARCH_DELAY_MS = 300;

const SCORE_FILTER_LABELS: Record<ResultsScoreFilter, string> = {
  all: "All",
  unscored: "Unscored",
  underTwo: "Fewer than 2 judges",
};

type ResultsView = { query: string; scored: ResultsScoreFilter; page: number };

/**
 * Judging → Results: the ranked score table (raw and adjusted scores, judges
 * counted, per-criterion averages), the "Adjust for harsh/generous judges"
 * switch that picks which score ranks, CSV export, and publishing. Scores and comments
 * stay organiser-only; the public results page shows awards and winners.
 *
 * The ranking is computed on the server over every project, so ranks and
 * ties are the same on every page; the table shows one numbered page at a
 * time (`loadResultsPage`), and a search filters the ranked rows without
 * renumbering them. The CSV export holds every ranked row matching the
 * search showing, under the score method the table ranks by.
 */
export function JudgingPanelResults({
  scope,
  initialPage,
  criteria,
  judgingStatus,
  resultsPublishedAt,
  resultsUrl,
  exportHref,
  timezone,
  savedViews = NO_SAVED_VIEWS,
  roundId = null,
  readOnly = false,
}: {
  scope: JudgingScope;
  initialPage: JudgingDashboardResultsPage;
  criteria: JudgingDashboardCriterion[];
  judgingStatus: JudgingStatus;
  resultsPublishedAt: string | null;
  resultsUrl: string;
  exportHref: string;
  timezone: string;
  /** Saved views for this list (the viewer's own and shared ones). */
  savedViews?: readonly SavedViewDto[];
  /** A judging round other than the current one (docs/HACKATHON.md "Rounds"); null for the current round. */
  roundId?: string | null;
  /** An earlier or later round: no score-method switch and no publishing (both act on the current round). */
  readOnly?: boolean;
}) {
  const { organisationSlug, eventId } = scope;
  // Filters live in the address bar (saved views): a link reopens the same view.
  const fromUrl = useInitialViewParams("JUDGING_RESULTS");
  const [data, setData] = useState<JudgingDashboardResultsPage>(initialPage);
  const [query, setQuery] = useState(viewParam(fromUrl, "q"));
  const [scored, setScored] = useState<ResultsScoreFilter>(viewParam(fromUrl, "scored") as ResultsScoreFilter);
  const [loading, setLoading] = useState(() => scored !== "all" || Boolean(query.trim()));
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const view = useRef<ResultsView>({ query, scored, page: 1 });
  const [searchedQuery, setSearchedQuery] = useState(query.trim());
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchedQuery(query.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  const viewParams: ViewParams = {};
  if (scored !== "all") viewParams.scored = scored;
  if (searchedQuery) viewParams.q = searchedQuery;
  useSyncViewToUrl("JUDGING_RESULTS", viewParams);
  const applyView = useCallback((params: ViewParams) => {
    setScored(viewParam(params, "scored") as ResultsScoreFilter);
    setQuery(viewParam(params, "q"));
  }, []);

  const fetchPage = useCallback(
    async (next: ResultsView) => {
      const seq = ++requestSeq.current;
      view.current = next;
      setLoading(true);
      setError(null);
      const res = await loadResultsPage({ organisationSlug, eventId, query: next.query.trim(), page: next.page, scored: next.scored, ...(roundId ? { roundId } : {}) });
      if (seq !== requestSeq.current) return;
      setLoading(false);
      if (!res.ok || !res.data) {
        setError(res.ok ? "Could not load the ranking." : res.error);
        return;
      }
      setData(res.data);
      view.current = { query: next.query, scored: next.scored, page: res.data.page };
    },
    [organisationSlug, eventId, roundId],
  );

  // A search fetches its first page once typing pauses. A refresh after a
  // change (new `initialPage`) re-reads the page and search showing.
  // A filter set from the address bar loads on mount; a score filter applies at once.
  const firstRun = useRef(true);
  const lastQuery = useRef(query);
  const lastScored = useRef(scored);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      if (scored === "all" && !query.trim()) return;
      const timer = window.setTimeout(() => void fetchPage({ query, scored, page: 1 }), 0);
      return () => window.clearTimeout(timer);
    }
    const queryChanged = lastQuery.current !== query;
    const scoredChanged = lastScored.current !== scored;
    lastQuery.current = query;
    lastScored.current = scored;
    const target: ResultsView = queryChanged || scoredChanged ? { query, scored, page: 1 } : view.current;
    const timer = window.setTimeout(() => {
      if (!target.query.trim() && target.scored === "all" && target.page === 1) {
        requestSeq.current += 1;
        view.current = { query: target.query, scored: "all", page: 1 };
        setLoading(false);
        setError(null);
        setData(initialPage);
        return;
      }
      void fetchPage(target);
    }, queryChanged && query.trim() ? SEARCH_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
  }, [query, scored, fetchPage, initialPage]);

  const scoreMethod = useJudgingAction();
  const [pendingMethod, setPendingMethod] = useState<"RAW" | "ZSCORE" | null>(null);
  const method = pendingMethod ?? initialPage.scoreNormalization;
  const adjusted = method === "ZSCORE";
  const copy = scoreMethodCopy(method);
  function changeMethod(next: "RAW" | "ZSCORE") {
    setPendingMethod(next);
    scoreMethod.run("method", () => changeScoreNormalization({ organisationSlug, eventId, scoreNormalization: next }), scoreMethodCopy(next).savedToast, () => setPendingMethod(null));
  }

  const searching = Boolean(query.trim()) || scored !== "all";
  const scoreCounts = data.scoreCounts ?? initialPage.scoreCounts;
  return (
    <div className="flex flex-col gap-5">
      {readOnly ? null : <PublishCard scope={scope} judgingStatus={judgingStatus} resultsPublishedAt={resultsPublishedAt} resultsUrl={resultsUrl} timezone={timezone} />}
      <Card as="section">
        <CardHeader
          title="Ranking"
          description={copy.description}
          action={
            <Button asChild variant="secondary" size="sm">
              <a href={judgingResultsExportHref(exportHref, { query, method, scored, roundId })} download title="Export the ranked projects matching this search and score filter, with every review">
                <Download aria-hidden className="size-4" />
                Export CSV
              </a>
            </Button>
          }
        />
        {readOnly ? null : <SwitchRow
          className="mb-4 rounded-lg border border-line p-3.5"
          label="Adjust for harsh/generous judges"
          description="Rank by each judge's scores relative to their own average. Both scores stay in the table and the CSV. Scores are never public."
          checked={adjusted}
          disabled={scoreMethod.pending}
          onCheckedChange={(on) => changeMethod(on ? "ZSCORE" : "RAW")}
        />}
        {initialPage.rankedTotal === 0 ? (
          <EmptyState title="No submitted projects">The ranking fills in as judges submit their reviews.</EmptyState>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by judges counted">
                {RESULTS_SCORE_FILTERS.map((value) => (
                  <FilterChip key={value} selected={scored === value} onClick={() => setScored(value)}>
                    {SCORE_FILTER_LABELS[value]} <span className="font-medium opacity-80">{scoreCounts[value]}</span>
                  </FilterChip>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                <div className="w-full sm:w-[260px]">
                  <SearchInput placeholder="Search projects" aria-label="Search ranked projects" value={query} onChange={(event) => setQuery(event.target.value)} onClear={() => setQuery("")} />
                </div>
                <SavedViewsMenu surface="JUDGING_RESULTS" scope={scope} params={viewParams} onApply={applyView} initialViews={savedViews} />
              </div>
            </div>
            <p className="text-caption text-ink-muted" aria-live="polite">
              {numberedPageLabel({ start: data.start, total: data.total, shown: data.rows.length }, searching ? "matching projects" : "ranked projects")}
            </p>
            {error ? (
              <Callout tone="danger" role="alert">
                {error}
              </Callout>
            ) : null}
            {loading && data.rows.length === 0 ? (
              <div className="flex justify-center py-6">
                <Spinner className="size-5" />
                <span className="sr-only">Loading the ranking</span>
              </div>
            ) : data.rows.length === 0 ? (
              <EmptyState title="No matching projects">Try another filter or search.</EmptyState>
            ) : (
              <div aria-busy={loading} className={loading ? "opacity-60 transition-opacity" : undefined}>
                <Table label="Ranked projects">
                  <THead>
                    <tr>
                      <TH>Rank</TH>
                      <TH>Project</TH>
                      <TH className="text-right" aria-sort={adjusted ? undefined : "descending"}>
                        Raw
                        <span className="block font-normal">{adjusted ? "score" : "ranks"}</span>
                      </TH>
                      <TH className="text-right" aria-sort={adjusted ? "descending" : undefined}>
                        Adjusted
                        <span className="block font-normal">{adjusted ? "ranks" : "score"}</span>
                      </TH>
                      <TH className="text-right">Judges</TH>
                      {criteria.map((criterion) => (
                        <TH key={criterion.id} className="text-right" title={`Average out of ${criterion.maxScore}`}>
                          {criterion.name}
                          <span className="block font-normal">/ {criterion.maxScore}</span>
                        </TH>
                      ))}
                    </tr>
                  </THead>
                  <TBody>
                    {data.rows.map((row) => {
                      const averages = new Map(row.criterionAverages.map((average) => [average.criterionId, average.average]));
                      return (
                        <TR key={row.submissionId}>
                          <TD className="font-semibold">{row.rank ?? "—"}</TD>
                          <TD className="min-w-[200px]">
                            <span className="block font-semibold">{row.title}</span>
                            <span className="block text-caption text-ink-muted">{row.entrantName}</span>
                            {row.status === "DISQUALIFIED" ? (
                              <Chip size="sm" tone="danger" className="mt-1">
                                Disqualified
                              </Chip>
                            ) : null}
                          </TD>
                          <TD className={adjusted ? "text-right tabular-nums text-ink-secondary" : "text-right font-semibold tabular-nums"}>{formatScore(row.rawScore)}</TD>
                          <TD className={adjusted ? "text-right font-semibold tabular-nums" : "text-right tabular-nums text-ink-secondary"}>{formatScore(row.adjustedScore)}</TD>
                          <TD className="text-right tabular-nums">{row.judgesCounted}</TD>
                          {criteria.map((criterion) => (
                            <TD key={criterion.id} className="text-right tabular-nums">
                              {formatScore(averages.get(criterion.id) ?? null)}
                            </TD>
                          ))}
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
            )}
            <PageNumberPager label="Ranking pages" page={data.page} totalPages={data.totalPages} disabled={loading} onPage={(page) => void fetchPage({ query, scored, page })} />
          </div>
        )}
      </Card>
    </div>
  );
}
