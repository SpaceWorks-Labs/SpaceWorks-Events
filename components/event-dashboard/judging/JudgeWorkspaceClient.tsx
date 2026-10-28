"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowRight, CheckCircle2, ChevronRight, Users } from "lucide-react";
import type { JudgingStatus } from "@prisma/client";
import { loadJudgeSubmission, loadNextJudgeSubmission } from "@/app/actions/judging";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/button";
import { useLoadMoreFocus } from "@/components/ui/use-load-more-focus";
import { Callout, Card, Chip, EmptyState, ProgressBar } from "@/components/ui/display";
import { SearchInput } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import type { JudgeSubmissionDetailDto, JudgeSubmissionsPageDto, JudgingCriterionDto } from "@/lib/judgingDto";
import { JUDGING_SEARCH_MAX_LENGTH, type JudgeSubmissionCounts } from "@/lib/judgingPaging";
import {
  JUDGE_FILTER_OPTIONS,
  judgeEmptyViewText,
  judgeProgressChip,
  judgeProgressFromCounts,
  judgingStatusNotice,
  noRubricNotice,
  scoreNextToast,
  type WorkspaceAudience,
} from "./judgeProgress";
import { OpenTabButton } from "../EventDashboardTabs";
import { ScoringView } from "./JudgeWorkspaceClient/ScoringView";
import type { Scope } from "./JudgeWorkspaceClient/types";
import { useJudgeSubmissionsList } from "./JudgeWorkspaceClient/useJudgeSubmissionsList";

/**
 * Client half of the judge workspace: the list of submissions with this
 * judge's progress, and a scoring view loaded on demand. All reads and
 * writes go through app/actions/judging.ts, which re-checks access.
 *
 * The list is paged on the server: the first page and the totals come with
 * the panel; filters, search and "Load more" fetch bounded pages through
 * `loadJudgeSubmissionsPage`. The list state stays here while a submission
 * is open, so "All submissions" returns to the same filter, search and pages.
 *
 * "Score next project" asks the server which project to score next
 * (`loadNextJudgeSubmission`: one already started, then the fewest reviews,
 * then the oldest) and opens it. After a fresh review is submitted, the next
 * one opens on its own with a toast that leads back to the list; when nothing
 * is left, the list shows a done state. Focus moves to the project heading.
 */
export function JudgeWorkspaceClient({
  organisationSlug,
  eventId,
  roundId = null,
  judgingStatus,
  criteria,
  initialPage,
  audience = "judge",
}: Scope & {
  /** Organisers (owners/admins in the Judging tab) get organiser copy and a link to the rubric editor. */
  audience?: WorkspaceAudience;
  judgingStatus: JudgingStatus;
  criteria: JudgingCriterionDto[];
  /** First page of the unfiltered list, plus totals over everything this judge may see. */
  initialPage: JudgeSubmissionsPageDto;
}) {
  const { showToast } = useToast();
  const [detail, setDetail] = useState<JudgeSubmissionDetailDto | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const request = useRef(0);

  const { filter, setFilter, query, setQuery, submissions, setSubmissions, nextCursor, counts, loadingList, listError, fetchPage } = useJudgeSubmissionsList({ organisationSlug, eventId, roundId, initialPage });

  // Keyboard and screen-reader focus: the list button that opened a submission
  // unmounts with the list, so focus returns to it when the judge goes back,
  // or to the list heading when it has left this view (e.g. now reviewed).
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const loadMoreFocus = useLoadMoreFocus(submissions.length);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (detail || !returnFocusId) return;
    const button = listRef.current?.querySelector<HTMLButtonElement>(`button[data-submission-id="${CSS.escape(returnFocusId)}"]`);
    if (button) button.focus();
    else headingRef.current?.focus({ preventScroll: true });
  }, [detail, returnFocusId]);
  const notice = judgingStatusNotice(judgingStatus, audience);
  const noRubric = noRubricNotice(audience);
  const summary = judgeProgressFromCounts(counts);

  // Score next: the server said nothing is left, for the totals showing then
  // (fresh totals after a refresh replace `counts`, which ends it).
  const [exhaustedAt, setExhaustedAt] = useState<JudgeSubmissionCounts | null>(null);
  const nextExhausted = exhaustedAt === counts;
  const [findingNext, setFindingNext] = useState(false);
  const focusDone = useRef(false);
  const doneRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (detail || !focusDone.current) return;
    focusDone.current = false;
    (doneRef.current ?? headingRef.current)?.focus({ preventScroll: true });
  }, [detail, exhaustedAt]);
  const canScore = judgingStatus === "OPEN" && criteria.length > 0;
  const allReviewed = canScore && counts.all > 0 && (counts.todo === 0 || nextExhausted);

  function open(submissionId: string) {
    const ticket = ++request.current;
    setOpeningId(submissionId);
    startTransition(async () => {
      const res = await loadJudgeSubmission({ organisationSlug, eventId, submissionId, ...(roundId ? { roundId } : {}) });
      if (ticket !== request.current) return;
      setOpeningId(null);
      if (!res.ok || !res.data) {
        showToast(res.ok ? "This submission is not available to you." : res.error, "error");
        return;
      }
      setDetail(res.data);
      window.scrollTo({ top: 0, behavior: "auto" });
    });
  }

  function close() {
    request.current++;
    setOpeningId(null);
    setFindingNext(false);
    setReturnFocusId(detail?.submission.id ?? null);
    setDetail(null);
  }

  /**
   * Open the project the server picks next. `advancing` is set after a
   * submitted review: the toast says what opened (with a way back to the
   * list), and when nothing is left the list's done state takes focus.
   */
  function scoreNext(advancing: boolean) {
    const ticket = ++request.current;
    setFindingNext(true);
    startTransition(async () => {
      const res = await loadNextJudgeSubmission({ organisationSlug, eventId, ...(roundId ? { roundId } : {}) });
      if (ticket !== request.current) return;
      setFindingNext(false);
      if (!res.ok || !res.data) {
        showToast(res.ok ? "Could not find the next project." : res.error, "error");
        return;
      }
      const { next, remaining } = res.data;
      if (!next) {
        focusDone.current = true;
        setExhaustedAt(counts);
        setReturnFocusId(null);
        setDetail(null);
        showToast(advancing ? scoreNextToast(null) : "Nothing left to score. Every review is submitted.", advancing ? "success" : "info");
        return;
      }
      setDetail(next);
      window.scrollTo({ top: 0, behavior: "auto" });
      if (advancing) showToast(scoreNextToast({ title: next.submission.title, remaining }), "success", { label: "Back to list", onClick: close });
    });
  }

  if (detail) {
    return (
      <ScoringView
        key={detail.submission.id}
        scope={{ organisationSlug, eventId }}
        detail={detail}
        onBack={close}
        audience={audience}
        advancing={findingNext}
        onSubmitted={() => scoreNext(true)}
        onSaved={(next) => {
          setDetail(next);
          // Keep the loaded list in step until the refreshed page arrives.
          setSubmissions((current) => current.map((row) => (row.id === next.submission.id ? next.submission : row)));
        }}
      />
    );
  }

  return (
    <section aria-labelledby="judge-workspace-title" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="judge-workspace-title" ref={headingRef} tabIndex={-1} className="text-title text-ink focus:outline-none">Score submissions</h2>
        <p className="text-body-ui text-ink-muted">
          Read each project, score it against the rubric, and submit your review. Your comments are private to the organisers.
        </p>
      </div>

      {notice ? <Callout tone={judgingStatus === "CLOSED" ? "info" : "warning"} title={notice.title}>{notice.body}</Callout> : null}
      {criteria.length === 0 ? (
        <Callout
          tone="warning"
          title={noRubric.title}
          action={
            audience === "organiser" ? (
              <OpenTabButton tab="judging" sub="judging-setup" className="inline-flex min-h-9 items-center text-sm font-semibold text-ink underline underline-offset-2 hover:text-ink-secondary">
                Edit the rubric
              </OpenTabButton>
            ) : undefined
          }
        >
          {noRubric.body}
        </Callout>
      ) : null}

      {counts.all === 0 ? (
        <EmptyState title="No submissions to score">
          Submitted projects you are asked to judge will appear here. Projects from a team or registration you belong to are never shown to you.
        </EmptyState>
      ) : (
        <>
          <Card padding="sm" className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-label text-ink">
                {summary.submitted} of {summary.total} {summary.total === 1 ? "review" : "reviews"} submitted
              </p>
              {summary.started > 0 ? <p className="text-caption text-ink-muted">{summary.started} in progress</p> : null}
            </div>
            <ProgressBar value={summary.submitted} max={summary.total} tone="success" label="Reviews submitted" />
            {canScore && !allReviewed ? (
              <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
                <p className="text-caption text-ink-muted">Picks a project you started, or the one with the fewest reviews so far.</p>
                <Button variant="primary" onClick={() => scoreNext(false)} loading={findingNext} loadingLabel="Finding the next project…" disabled={openingId !== null} endIcon={<ArrowRight aria-hidden className="size-4" />}>
                  Score next project
                </Button>
              </div>
            ) : null}
          </Card>

          {allReviewed ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-canvas px-5 py-6 text-center">
              <CheckCircle2 aria-hidden className="size-7 text-success-fg" />
              <h3 ref={doneRef} tabIndex={-1} className="text-title text-ink focus:outline-none">You&apos;re all caught up</h3>
              <p className="max-w-[46ch] text-body-ui text-ink-muted">
                You&apos;ve submitted a review for every project you can score. You can still open any project below to update your review while judging is open.
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2.5">
            <div role="group" aria-label="Filter submissions by your progress" className="flex flex-wrap gap-1.5">
              {JUDGE_FILTER_OPTIONS.map(({ value, label }) => {
                const on = filter === value;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setFilter(value)}
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
              <label htmlFor="judge-submission-search" className="sr-only">Search submissions by project or entrant</label>
              <SearchInput
                id="judge-submission-search"
                placeholder="Search project or team"
                value={query}
                maxLength={JUDGING_SEARCH_MAX_LENGTH}
                onChange={(event) => setQuery(event.target.value)}
                onClear={() => setQuery("")}
                autoComplete="off"
                className="py-2 sm:text-sm"
              />
            </div>
          </div>

          {listError ? <Callout tone="danger" role="alert">{listError}</Callout> : null}

          {loadingList === "replace" ? (
            <p role="status" className="text-body-ui text-ink-muted">Loading submissions…</p>
          ) : submissions.length === 0 ? (
            <EmptyState>{judgeEmptyViewText(filter, query)}</EmptyState>
          ) : (
            <ul ref={listRef} id={loadMoreFocus.listId} aria-label="Submissions" aria-busy={loadingList != null} className="flex flex-col gap-2.5">
              {submissions.map((submission) => {
                const chip = judgeProgressChip(submission, criteria.length);
                const busy = openingId === submission.id;
                return (
                  <li key={submission.id}>
                    <button
                      type="button"
                      data-submission-id={submission.id}
                      onClick={() => open(submission.id)}
                      disabled={openingId !== null}
                      aria-busy={busy || undefined}
                      className="flex w-full items-center gap-3 rounded-lg border border-line bg-canvas p-4 text-left transition-colors hover:bg-subtle disabled:cursor-progress focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--yy-focus)]"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-[17px] font-bold text-ink">{submission.title}</span>
                        <span className="flex min-w-0 items-center gap-1.5 text-caption text-ink-muted">
                          {submission.isTeam ? <Users aria-hidden className="size-3.5 shrink-0" /> : null}
                          <span className="truncate">{submission.entrantName}</span>
                        </span>
                        {submission.summary ? <span className="line-clamp-2 text-body-ui text-ink-secondary">{submission.summary}</span> : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Chip tone={chip.tone} size="sm">{chip.label}</Chip>
                        {busy ? <Spinner className="size-4" /> : <ChevronRight aria-hidden className="size-4 text-ink-muted" />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {nextCursor && loadingList !== "replace" ? (
            <div className="flex justify-center">
              <Button variant="secondary" loading={loadingList === "more"} loadingLabel="Loading…" onClick={() => {
                loadMoreFocus.beforeLoadMore();
                void fetchPage({ query, filter }, nextCursor);
              }}>
                Load more submissions
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
