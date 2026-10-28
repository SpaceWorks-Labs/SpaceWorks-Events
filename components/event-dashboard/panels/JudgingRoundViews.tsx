"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import { loadResultsPage } from "@/app/actions/judging-admin";
import { loadJudgingProgressRound } from "@/app/actions/judging-ops";
import { Callout } from "@/components/ui/display";
import { Spinner } from "@/components/ui/spinner";
import type { JudgingDashboardCriterion, JudgingDashboardResultsPage } from "@/lib/eventDashboard/judging";
import type { JudgingProgressDto } from "@/lib/core/judgingOps";
import { JudgingPanelProgress } from "./JudgingPanelProgress";
import { JudgingPanelResults } from "./JudgingPanelResults";
import { JudgingRoundSwitcher, type JudgingRoundOption } from "./JudgingRoundSwitcher";

/*
 * Judging → Results and Progress with a round switcher (docs/HACKATHON.md
 * "Rounds"). The current round renders exactly as before, from the server
 * render; another round loads through the same paged actions with its
 * `roundId` and shows read-only (score method, publishing, the target and
 * automatic assignment all act on the current round).
 */

type RoundView = JudgingRoundOption & { criteria: JudgingDashboardCriterion[] };

/** Load one round's data when another round is picked; the current round needs none. */
function useRoundPick<T>(rounds: readonly RoundView[], load: (roundId: string) => Promise<{ ok: true; data?: T } | { ok: false; error: string }>) {
  const current = rounds.find((round) => round.isCurrent)?.id ?? rounds[0]?.id ?? "";
  const [picked, setPicked] = useState(current);
  const [loaded, setLoaded] = useState<{ roundId: string; data: T } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function pick(roundId: string) {
    setPicked(roundId);
    setError(null);
    if (roundId === current) return;
    setLoading(true);
    const result = await load(roundId);
    setLoading(false);
    if (!result.ok || !result.data) setError(result.ok ? "Could not load that round." : result.error);
    else setLoaded({ roundId, data: result.data });
  }
  const round = rounds.find((item) => item.id === picked);
  const other = picked !== current && loaded?.roundId === picked ? loaded.data : null;
  return { current, picked, pick, round, other, loading, error };
}

function Frame({ rounds, picked, pick, loading, error, children }: { rounds: readonly RoundView[]; picked: string; pick: (id: string) => void; loading: boolean; error: string | null; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <JudgingRoundSwitcher rounds={rounds} value={picked} onChange={pick} disabled={loading} />
      {error ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}
      {loading ? (
        <div className="flex justify-center py-6">
          <Spinner className="size-5" />
          <span className="sr-only">Loading the round</span>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export function JudgingResultsByRound({ rounds, ...props }: ComponentProps<typeof JudgingPanelResults> & { rounds: readonly RoundView[] }) {
  const { scope } = props;
  const view = useRoundPick<JudgingDashboardResultsPage>(rounds, (roundId) => loadResultsPage({ ...scope, query: "", page: 1, scored: "all", roundId }));
  const content =
    view.picked === view.current || !view.round ? (
      <JudgingPanelResults {...props} />
    ) : view.other ? (
      <JudgingPanelResults
        key={view.picked}
        {...props}
        initialPage={view.other}
        criteria={view.round.criteria}
        judgingStatus={view.round.judgingStatus}
        roundId={view.picked}
        readOnly
      />
    ) : null;
  return (
    <Frame rounds={rounds} picked={view.picked} pick={(id) => void view.pick(id)} loading={view.loading} error={view.error}>
      {content}
    </Frame>
  );
}

export function JudgingProgressByRound({ rounds, ...props }: ComponentProps<typeof JudgingPanelProgress> & { rounds: readonly RoundView[] }) {
  const { scope } = props;
  const view = useRoundPick<JudgingProgressDto>(rounds, (roundId) => loadJudgingProgressRound({ ...scope, roundId }));
  const content =
    view.picked === view.current || !view.round ? (
      <JudgingPanelProgress {...props} />
    ) : view.other ? (
      <JudgingPanelProgress key={view.picked} {...props} initial={view.other} roundId={view.picked} readOnly />
    ) : null;
  return (
    <Frame rounds={rounds} picked={view.picked} pick={(id) => void view.pick(id)} loading={view.loading} error={view.error}>
      {content}
    </Frame>
  );
}
