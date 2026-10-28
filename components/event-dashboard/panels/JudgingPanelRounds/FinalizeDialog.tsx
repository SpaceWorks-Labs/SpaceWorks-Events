"use client";

import { useState } from "react";
import { finalizeRound } from "@/app/actions/judging-rounds";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/field";
import type { JudgingDashboardRound } from "@/lib/eventDashboard/judgingRounds";
import { fieldError, useJudgingAction, type JudgingScope } from "../JudgingPanelShared";

/**
 * Finalise a closed round (docs/HACKATHON.md "Rounds"). The server checks
 * coverage: when projects are short of the round's review target it asks for
 * a reason, kept with the round for organisers only. A finalised round can't
 * reopen; finalists advance only from a finalised round.
 */
export function FinalizeDialog({ scope, round, open, onOpenChange, reasonMax }: { scope: JudgingScope; round: JudgingDashboardRound; open: boolean; onOpenChange: (open: boolean) => void; reasonMax: number }) {
  const { run, busy } = useJudgingAction();
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]> | undefined>();
  return (
    <Dialog open={open} onOpenChange={(next) => (busy === "finalize" ? undefined : onOpenChange(next))}>
      <DialogContent size="sm">
        <DialogHeader title={`Finalise ${round.name}?`} description="Its judging can't reopen afterwards. Finalists can then advance to the next round." />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            run("finalize", () => finalizeRound({ ...scope, roundId: round.id, reason }), "Round finalised.", (result) => {
              if (result.ok) onOpenChange(false);
              else setErrors(result.fieldErrors);
            });
          }}
        >
          <DialogBody>
            <Field label="Reason, if projects are short of reviews" optional helperText="Needed only when some projects have fewer counted reviews than the target. Organisers only." error={fieldError(errors, "reason")}>
              <Textarea rows={3} maxLength={reasonMax} value={reason} onChange={(event) => setReason(event.target.value)} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" disabled={busy === "finalize"} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy === "finalize"} loadingLabel="Finalising…">
              Finalise round
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
