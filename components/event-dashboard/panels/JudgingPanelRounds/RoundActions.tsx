"use client";

import { useState } from "react";
import { changeJudgingRoundStatus, publishRoundFinalists, removeJudgingRound, unfinalizeRound, unpublishRoundFinalists } from "@/app/actions/judging-rounds";
import { ConfirmationDialog } from "@/components/feedback/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import type { EligibleJudgeDto } from "@/lib/core/judging";
import type { JudgingDashboardRound } from "@/lib/eventDashboard/judgingRounds";
import { useJudgingAction, type JudgingScope } from "../JudgingPanelShared";
import { nextRoundAction } from "../judgingRoundsCopy";
import { AdvanceFinalistsDialog } from "./AdvanceFinalistsDialog";
import { FinalizeDialog } from "./FinalizeDialog";
import { RoundPanelDialog } from "./RoundPanelDialog";
import { RoundSettingsDialog } from "./RoundSettingsDialog";

type Open = "edit" | "panel" | "advance" | "finalize" | "delete" | null;

/** The buttons for one round: settings, panel, status, finalising, finalists and deleting. The server re-checks every rule. */
export function RoundActions({
  scope,
  round,
  judges,
  timezone,
  limits,
}: {
  scope: JudgingScope;
  round: JudgingDashboardRound;
  judges: EligibleJudgeDto[];
  timezone: string;
  limits: { roundName: number; finalizeReason: number };
}) {
  const { run, busy, pending } = useJudgingAction();
  const [open, setOpen] = useState<Open>(null);
  const close = (next: boolean) => (next ? undefined : setOpen(null));
  const step = nextRoundAction(round);
  const advanced = round.entrySource === "ADVANCED";
  const target = { ...scope, roundId: round.id };
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" disabled={pending} onClick={() => setOpen("edit")}>
        Edit round
      </Button>
      <Button variant="secondary" size="sm" disabled={pending || round.status === "CLOSED"} onClick={() => setOpen("panel")}>
        Choose judges
      </Button>
      {step ? (
        <Button variant={step.status === "OPEN" ? "primary" : "secondary"} size="sm" loading={busy === "status"} disabled={pending} onClick={() => run("status", () => changeJudgingRoundStatus({ ...target, status: step.status }), step.status === "OPEN" ? `${round.name} is open for judging.` : `${round.name} is closed.`)}>
          {step.label}
        </Button>
      ) : null}
      {round.status === "CLOSED" && !round.finalizedAt ? (
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => setOpen("finalize")}>
          Finalise round
        </Button>
      ) : null}
      {round.finalizedAt ? (
        <Button variant="secondary" size="sm" loading={busy === "unfinalize"} disabled={pending} onClick={() => run("unfinalize", () => unfinalizeRound(target), "Round no longer finalised.")}>
          Undo finalise
        </Button>
      ) : null}
      {advanced && round.status === "DRAFT" && !round.finalistsPublishedAt ? (
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => setOpen("advance")}>
          Advance finalists
        </Button>
      ) : null}
      {advanced && round.finalists > 0 ? (
        round.finalistsPublishedAt ? (
          <Button variant="secondary" size="sm" loading={busy === "finalists"} disabled={pending} onClick={() => run("finalists", () => unpublishRoundFinalists(target), "Finalists hidden.")}>
            Unpublish finalists
          </Button>
        ) : (
          <Button variant="accent" size="sm" loading={busy === "finalists"} disabled={pending} onClick={() => run("finalists", () => publishRoundFinalists(target), "Finalists published. Entrants are emailed only when results emails are on in Setup.")}>
            Publish finalists
          </Button>
        )
      ) : null}
      {round.position > 1 && round.status === "DRAFT" ? (
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => setOpen("delete")}>
          Delete round
        </Button>
      ) : null}

      {open === "edit" ? <RoundSettingsDialog scope={scope} round={round} open onOpenChange={close} timezone={timezone} nameMax={limits.roundName} /> : null}
      {open === "panel" ? <RoundPanelDialog scope={scope} round={round} judges={judges} open onOpenChange={close} /> : null}
      {open === "advance" ? <AdvanceFinalistsDialog scope={scope} round={round} open onOpenChange={close} /> : null}
      {open === "finalize" ? <FinalizeDialog scope={scope} round={round} open onOpenChange={close} reasonMax={limits.finalizeReason} /> : null}
      <ConfirmationDialog
        open={open === "delete"}
        title={`Delete ${round.name}?`}
        message="Its rubric, judges, assignments and finalists are removed. Later rounds move up."
        confirmLabel="Delete round"
        loading={busy === "delete"}
        onConfirm={() => run("delete", () => removeJudgingRound(target), "Round deleted.", () => setOpen(null))}
        onCancel={() => setOpen(null)}
      />
    </div>
  );
}
