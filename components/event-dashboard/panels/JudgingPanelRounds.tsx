"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { reorderJudgingRoundsAction } from "@/app/actions/judging-rounds";
import { Button, IconButton } from "@/components/ui/button";
import { Card, CardHeader, Chip, EmptyState } from "@/components/ui/display";
import type { EligibleJudgeDto } from "@/lib/core/judging";
import type { JudgingDashboardRound } from "@/lib/eventDashboard/judgingRounds";
import { formatDayTime } from "@/lib/format/datetime";
import { JudgingPanelRubric } from "./JudgingPanelRubric";
import { useJudgingAction, type JudgingLimits, type JudgingScope } from "./JudgingPanelShared";
import { entrySourceLine, panelLine, ROUND_STATUS_TONES, roundStatusLabel } from "./judgingRoundsCopy";
import { FinalistsList } from "./JudgingPanelRounds/FinalistsList";
import { RoundActions } from "./JudgingPanelRounds/RoundActions";
import { RoundSettingsDialog } from "./JudgingPanelRounds/RoundSettingsDialog";

/**
 * Judging → Rounds (docs/HACKATHON.md "Rounds"): the event's judging rounds
 * in order, then the chosen round's settings, judges, rubric and finalists.
 * A single "Main" round is how every event starts and behaves exactly as
 * judging did before rounds. Owners and admins only; every action is
 * re-checked on the server.
 */
export function JudgingPanelRounds({
  scope,
  rounds,
  judges,
  timezone,
  limits,
}: {
  scope: JudgingScope;
  rounds: JudgingDashboardRound[];
  judges: EligibleJudgeDto[];
  timezone: string;
  limits: JudgingLimits & { roundName: number; finalizeReason: number; rounds: number };
}) {
  const { run, pending } = useJudgingAction();
  const [selectedId, setSelectedId] = useState(() => rounds.find((round) => round.isCurrent)?.id ?? rounds[0]?.id ?? null);
  const [adding, setAdding] = useState(false);
  const selected = rounds.find((round) => round.id === selectedId) ?? rounds[0] ?? null;

  function move(index: number, offset: -1 | 1) {
    const ids = rounds.map((round) => round.id);
    const target = index + offset;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    run(`move-${rounds[index]!.id}`, () => reorderJudgingRoundsAction({ ...scope, ids }), null);
  }

  return (
    <div className="flex flex-col gap-5">
      <Card as="section">
        <CardHeader
          title="Rounds"
          description="Run judging in stages: each round has its own rubric, judges and assignments, and finalists advance from one round to the next. Results and awards come from the final round."
          action={
            <Button variant="secondary" size="sm" startIcon={<Plus />} disabled={rounds.length >= limits.rounds} onClick={() => setAdding(true)}>
              Add round
            </Button>
          }
        />
        {rounds.length === 0 ? (
          <EmptyState title="No rounds yet">Turn on submissions to start the first round, or add one.</EmptyState>
        ) : (
          <ol className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {rounds.map((round, index) => (
              <li key={round.id} className={round.id === selected?.id ? "bg-muted" : undefined}>
                <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                  <button type="button" className="min-w-0 flex-1 text-left" aria-current={round.id === selected?.id ? "true" : undefined} onClick={() => setSelectedId(round.id)}>
                    <span className="block text-label text-ink">
                      {round.position}. {round.name}
                    </span>
                    <span className="block text-caption text-ink-muted">{entrySourceLine(round)}</span>
                  </button>
                  <span className="flex shrink-0 flex-wrap items-center gap-2">
                    <Chip size="sm" tone={round.finalizedAt ? "ink" : ROUND_STATUS_TONES[round.status]}>
                      {roundStatusLabel(round)}
                    </Chip>
                    {round.isCurrent && rounds.length > 1 ? <Chip size="sm" tone="info">Current</Chip> : null}
                    {round.finalistsPublishedAt ? <Chip size="sm" tone="success">Finalists published</Chip> : null}
                    <IconButton label={`Move ${round.name} up`} size="sm" disabled={index === 0 || pending} onClick={() => move(index, -1)}>
                      <ArrowUp />
                    </IconButton>
                    <IconButton label={`Move ${round.name} down`} size="sm" disabled={index === rounds.length - 1 || pending} onClick={() => move(index, 1)}>
                      <ArrowDown />
                    </IconButton>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {selected ? (
        <Card as="section">
          <CardHeader title={selected.name} description={`${panelLine(selected.panelUserIds.length)} · ${selected.reviewsSubmitted} reviews submitted`} />
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-body-ui sm:grid-cols-2">
              <div>
                <dt className="inline text-ink-muted">Judges see: </dt>
                <dd className="inline">{selected.judgesSeeAll ? "every project in the round" : "their assigned projects"}</dd>
              </div>
              <div>
                <dt className="inline text-ink-muted">Target: </dt>
                <dd className="inline">{selected.reviewsPerProject ?? 3} judges per project</dd>
              </div>
              <div>
                <dt className="inline text-ink-muted">Fresh eyes: </dt>
                <dd className="inline">{selected.freshEyes ? "on" : "off"}</dd>
              </div>
              <div>
                <dt className="inline text-ink-muted">Planned: </dt>
                <dd className="inline">
                  {selected.opensAt ? formatDayTime(selected.opensAt, timezone) : "no start"} to {selected.closesAt ? formatDayTime(selected.closesAt, timezone) : "no end"}
                </dd>
              </div>
            </dl>
            <RoundActions scope={scope} round={selected} judges={judges} timezone={timezone} limits={limits} />
          </div>
        </Card>
      ) : null}

      {selected ? (
        <JudgingPanelRubric
          key={selected.id}
          scope={scope}
          roundId={selected.id}
          criteria={selected.criteria}
          frozen={selected.status !== "DRAFT"}
          frozenNote="This round's rubric is locked because the round has opened."
          limits={limits}
        />
      ) : null}

      {selected?.entrySource === "ADVANCED" ? (
        <Card as="section">
          <CardHeader title="Finalists" description="Projects advanced into this round. Fixed once the round opens." />
          <FinalistsList scope={scope} roundId={selected.id} count={selected.finalists} />
        </Card>
      ) : null}

      {adding ? <RoundSettingsDialog scope={scope} round={null} open onOpenChange={(next) => setAdding(next)} timezone={timezone} nameMax={limits.roundName} /> : null}
    </div>
  );
}
