"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { searchAwardCandidates, setEventAwardWinner } from "@/app/actions/judging-admin";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Callout } from "@/components/ui/display";
import { Radio, RadioGroup } from "@/components/ui/choice";
import { useLoadMoreFocus } from "@/components/ui/use-load-more-focus";
import { Dropdown, Field, SearchInput } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import type { JudgingDashboardAward, JudgingDashboardAwardCandidate } from "@/lib/eventDashboard/judging";
import { formatScore, useJudgingAction, type JudgingScope } from "../JudgingPanelShared";
import { placeLabel } from "./placeLabel";

const SEARCH_DELAY_MS = 300;

type CandidateList = { candidates: JudgingDashboardAwardCandidate[]; total: number; nextOffset: number | null };

function candidateLabel(row: JudgingDashboardAwardCandidate) {
  return `${row.rank ? `#${row.rank} · ${formatScore(row.score)}` : "Unranked"} · ${row.title}`;
}

/**
 * Pick a project for one award: a server search over the ranked SUBMITTED
 * projects (top ranks first) with "Show more", then the place.
 */
export function WinnerPicker({
  scope,
  award,
  maxPlace,
  onClose,
}: {
  scope: JudgingScope;
  award: JudgingDashboardAward | null;
  maxPlace: number;
  onClose: () => void;
}) {
  const { organisationSlug, eventId } = scope;
  const { run, busy } = useJudgingAction();
  const taken = new Set(award?.winners.map((winner) => winner.place) ?? []);
  const firstFree = Array.from({ length: maxPlace }, (_, index) => index + 1).find((place) => !taken.has(place)) ?? 1;
  const [state, setState] = useState<{ awardId: string | null; place: string; submissionId: string; selectedTitle: string; query: string }>({
    awardId: null,
    place: "1",
    submissionId: "",
    selectedTitle: "",
    query: "",
  });
  const [list, setList] = useState<CandidateList | null>(null);
  const loadMoreFocus = useLoadMoreFocus(list?.candidates.length ?? 0, { focus: "radio" });
  const [loading, setLoading] = useState<"replace" | "more" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  // Reset the picker for each award it opens on (adjusting state during render).
  if (award && state.awardId !== award.id) {
    setState({ awardId: award.id, place: String(firstFree), submissionId: "", selectedTitle: "", query: "" });
    setList(null);
    setError(null);
  }
  if (!award && state.awardId !== null) setState({ awardId: null, place: "1", submissionId: "", selectedTitle: "", query: "" });

  const fetchCandidates = useCallback(
    async (query: string, offset: number, winnerIds: Set<string>) => {
      const seq = ++requestSeq.current;
      setLoading(offset > 0 ? "more" : "replace");
      setError(null);
      const res = await searchAwardCandidates({ organisationSlug, eventId, query: query.trim(), offset });
      if (seq !== requestSeq.current) return;
      setLoading(null);
      if (!res.ok || !res.data) {
        setError(res.ok ? "Could not load projects." : res.error);
        return;
      }
      const page = res.data;
      setList((current) =>
        offset > 0 && current
          ? { candidates: [...current.candidates, ...page.candidates.filter((row) => !current.candidates.some((other) => other.submissionId === row.submissionId))], total: page.total, nextOffset: page.nextOffset }
          : page,
      );
      // Preselect the best-ranked project that doesn't already hold a place in this award.
      if (offset === 0) {
        const best = page.candidates.find((row) => !winnerIds.has(row.submissionId)) ?? page.candidates[0];
        setState((current) => (current.submissionId || !best ? current : { ...current, submissionId: best.submissionId, selectedTitle: best.title }));
      }
    },
    [organisationSlug, eventId],
  );

  // Load the top of the ranking when the picker opens, and search once typing pauses.
  const awardId = award?.id ?? null;
  const winnerKey = award?.winners.map((winner) => winner.submissionId).join(",") ?? "";
  useEffect(() => {
    if (!awardId) return;
    const winnerIds = new Set(winnerKey ? winnerKey.split(",") : []);
    const timer = window.setTimeout(() => void fetchCandidates(state.query, 0, winnerIds), state.query.trim() ? SEARCH_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
  }, [awardId, winnerKey, state.query, fetchCandidates]);

  const placeCount = Math.min(maxPlace, Math.max(3, Math.max(0, ...taken) + 1));
  const placeHolder = award?.winners.find((winner) => String(winner.place) === state.place);
  const selectedVisible = list?.candidates.some((row) => row.submissionId === state.submissionId) ?? false;
  return (
    <Dialog open={award !== null} onOpenChange={(next) => (!next && busy === null ? onClose() : undefined)}>
      <DialogContent size="sm">
        <DialogHeader title="Pick a winner" description={award ? `For ${award.name}. Projects are listed by rank.` : undefined} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!award || !state.submissionId) return;
            run("pick", () => setEventAwardWinner({ ...scope, awardId: award.id, submissionId: state.submissionId, place: state.place }), "Winner saved.", (result) => {
              if (result.ok) onClose();
            });
          }}
        >
          <DialogBody className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-2">
              <SearchInput
                placeholder="Search by project or entrant"
                aria-label="Search projects"
                value={state.query}
                onChange={(event) => setState((current) => ({ ...current, query: event.target.value }))}
                onClear={() => setState((current) => ({ ...current, query: "" }))}
              />
              {error ? (
                <Callout tone="danger" role="alert">
                  {error}
                </Callout>
              ) : null}
              <div className="max-h-[320px] overflow-y-auto rounded-lg border border-line p-3" aria-busy={loading != null}>
                {loading === "replace" || !list ? (
                  <div className="flex justify-center py-4">
                    <Spinner className="size-5" />
                    <span className="sr-only">Loading projects</span>
                  </div>
                ) : list.candidates.length === 0 ? (
                  <p className="text-body-ui text-ink-muted">{state.query.trim() ? "No submitted project matches." : "No submitted projects yet."}</p>
                ) : (
                  <RadioGroup id={loadMoreFocus.listId} aria-label="Project" value={selectedVisible ? state.submissionId : ""} onValueChange={(value) =>
                      setState((current) => ({ ...current, submissionId: value, selectedTitle: list.candidates.find((row) => row.submissionId === value)?.title ?? "" }))
                    }
                  >
                    {list.candidates.map((row) => (
                      <Radio key={row.submissionId} value={row.submissionId} label={candidateLabel(row)} description={row.entrantName} />
                    ))}
                  </RadioGroup>
                )}
                {list && list.nextOffset != null && loading !== "replace" ? (
                  <div className="mt-3 flex justify-center">
                    <Button
                      type="button"
                      variant="quiet"
                      size="sm"
                      loading={loading === "more"}
                      loadingLabel="Loading…"
                      onClick={() => {
                        loadMoreFocus.beforeLoadMore();
                        void fetchCandidates(state.query, list.nextOffset ?? 0, new Set(winnerKey ? winnerKey.split(",") : []));
                      }}
                    >
                      Show more
                    </Button>
                  </div>
                ) : null}
              </div>
              {state.submissionId && !selectedVisible && list ? <p className="text-caption text-ink-secondary">Selected: {state.selectedTitle}</p> : null}
              {list && list.candidates.length > 0 ? (
                <p className="text-caption text-ink-muted">
                  Showing {list.candidates.length} of {list.total} {state.query.trim() ? "matching" : "submitted"} projects
                </p>
              ) : null}
            </div>
            <Field
              label="Place"
              helperText={placeHolder ? `Replaces ${placeHolder.title} in this place.` : "If this project already holds another place in this award, it moves here."}
            >
              <Dropdown value={state.place} onChange={(event) => setState((current) => ({ ...current, place: event.target.value }))}>
                {Array.from({ length: placeCount }, (_, index) => index + 1).map((place) => (
                  <option key={place} value={String(place)}>
                    {placeLabel(place)}
                    {taken.has(place) ? " (taken)" : ""}
                  </option>
                ))}
              </Dropdown>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" disabled={busy !== null} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!state.submissionId} loading={busy === "pick"} loadingLabel="Saving…">
              Save winner
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
