"use client";

import { useState } from "react";
import { saveJudgingRoundPanel } from "@/app/actions/judging-rounds";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/choice";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Callout } from "@/components/ui/display";
import type { EligibleJudgeDto } from "@/lib/core/judging";
import type { JudgingDashboardRound } from "@/lib/eventDashboard/judgingRounds";
import { useJudgingAction, type JudgingScope } from "../JudgingPanelShared";

/**
 * Choose who judges one round (docs/HACKATHON.md "Rounds"). With nobody
 * ticked the round has no panel: every invited judge judges it, as before
 * rounds existed. Organisers only judge a round when ticked here or, with no
 * panel, as they always could.
 */
export function RoundPanelDialog({
  scope,
  round,
  judges,
  open,
  onOpenChange,
}: {
  scope: JudgingScope;
  round: JudgingDashboardRound;
  /** Everyone who can judge the event (JUDGE grants, then owners and admins). */
  judges: EligibleJudgeDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { run, busy } = useJudgingAction();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(round.panelUserIds));
  const toggle = (userId: string, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={(next) => (busy === "panel" ? undefined : onOpenChange(next))}>
      <DialogContent size="md">
        <DialogHeader title={`Judges for ${round.name}`} description="Tick the people who judge this round. Leave everyone unticked to let every invited judge judge it." />
        <DialogBody className="flex flex-col gap-3">
          {picked.size === 0 ? <Callout tone="info">No panel chosen: every invited judge judges this round.</Callout> : null}
          <fieldset className="flex flex-col gap-2.5">
            <legend className="sr-only">Judges for this round</legend>
            {judges.map((judge) => (
              <CheckboxField
                key={judge.userId}
                label={judge.name}
                description={judge.kind === "admin" ? "Organiser" : judge.email ?? "Invited judge"}
                checked={picked.has(judge.userId)}
                onCheckedChange={(on) => toggle(judge.userId, on === true)}
              />
            ))}
          </fieldset>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" disabled={busy === "panel"} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "panel"}
            loadingLabel="Saving…"
            onClick={() => run("panel", () => saveJudgingRoundPanel({ ...scope, roundId: round.id, userIds: [...picked] }), picked.size ? "Panel saved." : "Every invited judge now judges this round.", (result) => result.ok && onOpenChange(false))}
          >
            Save panel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
