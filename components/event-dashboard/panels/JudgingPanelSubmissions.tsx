"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Download } from "lucide-react";
import type { SubmissionStatus } from "@prisma/client";
import {
  loadProjectReviews,
  reinstateProject,
  type SubmissionReviewView,
} from "@/app/actions/judging-admin";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/button";
import { FilterChip } from "@/components/ui/choice";
import { Callout, EmptyState } from "@/components/ui/display";
import { ConfirmationDialog } from "@/components/feedback/ConfirmationDialog";
import { SearchInput } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { showingLabel } from "@/lib/keysetCursor";
import { NO_SAVED_VIEWS, viewParam, type SavedViewDto, type ViewParams } from "@/lib/savedViews";
import { SavedViewsMenu } from "@/components/event-dashboard/views/SavedViewsMenu";
import { useInitialViewParams, useSyncViewToUrl } from "@/components/event-dashboard/views/useViewUrl";
import { JudgingUnsubmittedList } from "./JudgingUnsubmittedList";
import { judgingSubmissionsExportHref } from "@/lib/judgingExport";
import type {
  JudgingDashboardAward,
  JudgingDashboardCriterion,
  JudgingDashboardJudge,
  JudgingDashboardSubmission,
  JudgingDashboardSubmissionsPage,
} from "@/lib/eventDashboard/judging";
import { awardsHeldBy, reinstateImpact } from "./judgingCopy";
import {
  useJudgingAction,
  type JudgingLimits,
  type JudgingScope,
} from "./JudgingPanelShared";
import { AssignDialog, DisqualifyDialog, ProjectDialog, ReviewsDialog } from "./JudgingPanelSubmissions/dialogs";
import { SubmissionRow } from "./JudgingPanelSubmissions/SubmissionRow";
import { FILTERS, SEARCH_DELAY_MS, type Filter } from "./JudgingPanelSubmissions/types";
import { useSubmissionsList } from "./JudgingPanelSubmissions/useSubmissionsList";

export { ProjectLink } from "./JudgingPanelSubmissions/dialogs";

/**
 * Judging → Submissions: every project with its status, organiser-only
 * disqualification reason, judge assignments, and the judges' reviews. Entrant
 * emails and ticket links never reach this view.
 *
 * The list is paged on the server, oldest first, like Guests → Teams: the
 * first page comes with the panel, and status filters, searches and "Load
 * more" fetch bounded pages through `loadSubmissionsPage`. The chip counts
 * are per-status totals for the whole event.
 */
export function JudgingPanelSubmissions({
  scope,
  initialPage,
  counts,
  total,
  judges,
  criteria,
  judgesSeeAll,
  timezone,
  awards,
  resultsPublished,
  limits,
  unsubmittedCount = 0,
  savedViews = NO_SAVED_VIEWS,
}: {
  scope: JudgingScope;
  initialPage: JudgingDashboardSubmissionsPage;
  counts: Record<SubmissionStatus, number>;
  /** Every project of the event, whatever its status. */
  total: number;
  judges: JudgingDashboardJudge[];
  criteria: JudgingDashboardCriterion[];
  judgesSeeAll: boolean;
  timezone: string;
  /** Award winners, to say which awards a disqualification takes away. */
  awards: JudgingDashboardAward[];
  /** Once results are published, disqualifying changes the live results page. */
  resultsPublished: boolean;
  limits: JudgingLimits;
  /** Confirmed teams and solo registrants without a SUBMITTED project (the "Not submitted" view). */
  unsubmittedCount?: number;
  /** Saved views for this list (the viewer's own and shared ones). */
  savedViews?: readonly SavedViewDto[];
}) {
  const { run, busy } = useJudgingAction();
  // Filters live in the address bar (saved views): a link reopens the same view.
  const fromUrl = useInitialViewParams("JUDGING_SUBMISSIONS");
  const [filter, setFilter] = useState<Filter>(viewParam(fromUrl, "status") as Filter);
  const [query, setQuery] = useState(viewParam(fromUrl, "q"));
  const [searchedQuery, setSearchedQuery] = useState(query.trim());
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchedQuery(query.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  const viewParams: ViewParams = {};
  if (filter !== "all") viewParams.status = filter;
  if (searchedQuery) viewParams.q = searchedQuery;
  useSyncViewToUrl("JUDGING_SUBMISSIONS", viewParams);
  const applyView = useCallback((params: ViewParams) => {
    setFilter(viewParam(params, "status") as Filter);
    setQuery(viewParam(params, "q"));
  }, []);
  const [viewing, setViewing] = useState<JudgingDashboardSubmission | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [disqualifying, setDisqualifying] = useState<JudgingDashboardSubmission | null>(null);
  const [reinstating, setReinstating] = useState<JudgingDashboardSubmission | null>(null);
  const [reviewing, setReviewing] = useState<JudgingDashboardSubmission | null>(null);
  const [reviews, setReviews] = useState<{ id: string; rows: SubmissionReviewView[] } | null>(null);
  const [, startLoading] = useTransition();
  const { showToast } = useToast();

  const { submissions, loadMoreFocus, nextCursor, loadingList, listError, fetchPage } = useSubmissionsList({ scope, initialPage, filter, query });
  const { eventId } = scope;

  function openReviews(submission: JudgingDashboardSubmission) {
    setReviewing(submission);
    setReviews(null);
    startLoading(async () => {
      const result = await loadProjectReviews({ ...scope, submissionId: submission.id });
      if (!result.ok) {
        showToast(result.error, "error");
        setReviewing(null);
        return;
      }
      setReviews({ id: submission.id, rows: result.data ?? [] });
    });
  }

  const judgeNames = useMemo(() => new Map(judges.map((judge) => [judge.userId, judge.name])), [judges]);
  const chipCounts: Record<Filter, number> = { all: total, ...counts, notSubmitted: unsubmittedCount };
  // Re-read from the loaded rows so the assignment dialog shows current state.
  const assigning = assigningId ? submissions.find((submission) => submission.id === assigningId) ?? null : null;

  if (total === 0 && unsubmittedCount === 0) {
    return <EmptyState title="No projects yet">Projects appear here once confirmed entrants start a submission.</EmptyState>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {FILTERS.map((item) => (
            <FilterChip key={item.value} selected={filter === item.value} onClick={() => setFilter(item.value)}>
              {item.label} <span className="font-medium opacity-80">{chipCounts[item.value]}</span>
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <div className="w-full sm:w-[260px]">
            <SearchInput placeholder="Search projects" aria-label="Search projects" value={query} onChange={(event) => setQuery(event.target.value)} onClear={() => setQuery("")} />
          </div>
          <SavedViewsMenu surface="JUDGING_SUBMISSIONS" scope={scope} params={viewParams} onApply={applyView} initialViews={savedViews} />
          {chipCounts[filter] > 0 ? (
            <Button asChild variant="secondary" startIcon={<Download />}>
              <a
                href={judgingSubmissionsExportHref(`/api/exports/events/${eventId}/judging`, { query, status: filter })}
                title={filter === "notSubmitted" ? "Export every entrant without a submitted project matching this search" : "Export every project matching this filter and search"}
              >
                Export CSV
              </a>
            </Button>
          ) : (
            <Button variant="secondary" startIcon={<Download />} disabled title={filter === "notSubmitted" ? "No entrants match this filter" : "No projects match this filter"}>
              Export CSV
            </Button>
          )}
        </div>
      </div>
      {judgesSeeAll ? null : (
        <Callout tone="info">Judges only see the projects assigned to them. Use Assign judges on each submitted project.</Callout>
      )}
      {listError ? (
        <Callout tone="danger" role="alert">
          {listError}
        </Callout>
      ) : null}
      {filter === "notSubmitted" ? (
        <JudgingUnsubmittedList scope={scope} query={query} total={unsubmittedCount} timezone={timezone} />
      ) : loadingList === "replace" ? (
        <div className="flex justify-center py-6">
          <Spinner className="size-5" />
          <span className="sr-only">Loading projects</span>
        </div>
      ) : submissions.length === 0 ? (
        <EmptyState title="No matching projects">Try another filter or search.</EmptyState>
      ) : (
        <ul id={loadMoreFocus.listId} aria-label="Projects" aria-busy={loadingList != null} className="flex flex-col divide-y divide-line rounded-lg border border-line bg-canvas">
          {submissions.map((submission) => (
            <SubmissionRow
              key={submission.id}
              submission={submission}
              judgesSeeAll={judgesSeeAll}
              timezone={timezone}
              judgeNames={judgeNames}
              busy={busy}
              setViewing={setViewing}
              openReviews={openReviews}
              setAssigningId={setAssigningId}
              setDisqualifying={setDisqualifying}
              setReinstating={setReinstating}
            />
          ))}
        </ul>
      )}
      {filter !== "notSubmitted" && loadingList !== "replace" && submissions.length > 0 && !query.trim() ? (
        <p className="text-center text-caption text-ink-muted" aria-live="polite">
          {showingLabel(submissions.length, chipCounts[filter], "projects")}
        </p>
      ) : null}
      {filter !== "notSubmitted" && nextCursor && loadingList !== "replace" ? (
        <div className="flex justify-center">
          <Button variant="secondary" loading={loadingList === "more"} loadingLabel="Loading…" onClick={() => {
            loadMoreFocus.beforeLoadMore();
            void fetchPage({ query, status: filter }, nextCursor);
          }}>
            Load more projects
          </Button>
        </div>
      ) : null}

      <ProjectDialog submission={viewing} onClose={() => setViewing(null)} />
      <AssignDialog scope={scope} submission={assigning} judges={judges} onClose={() => setAssigningId(null)} />
      <DisqualifyDialog
        scope={scope}
        submission={disqualifying}
        awardsHeld={disqualifying ? awardsHeldBy(awards, disqualifying.id) : []}
        resultsPublished={resultsPublished}
        maxLength={limits.disqualifyReason}
        onClose={() => setDisqualifying(null)}
      />
      <ConfirmationDialog
        open={reinstating !== null}
        title="Reinstate this project?"
        message={reinstating ? reinstateImpact({ title: reinstating.title, resultsPublished }) : ""}
        confirmLabel="Reinstate"
        destructive={false}
        loading={reinstating !== null && busy === reinstating.id}
        onConfirm={() => {
          if (!reinstating) return;
          run(reinstating.id, () => reinstateProject({ ...scope, submissionId: reinstating.id }), "Project reinstated.", () => setReinstating(null));
        }}
        onCancel={() => setReinstating(null)}
      />
      <ReviewsDialog
        submission={reviewing}
        reviews={reviewing && reviews?.id === reviewing.id ? reviews.rows : null}
        criteria={criteria}
        timezone={timezone}
        onClose={() => setReviewing(null)}
      />
    </div>
  );
}
