"use client";

import { useState } from "react";
import { addJudgingRound, editJudgingRound } from "@/app/actions/judging-rounds";
import { Button } from "@/components/ui/button";
import { SwitchRow } from "@/components/ui/choice";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Dropdown, Field, Input } from "@/components/ui/field";
import type { JudgingDashboardRound } from "@/lib/eventDashboard/judgingRounds";
import { zonedDatetimeLocalValue, zonedInputToIso } from "@/lib/timeZone";
import { fieldError, useJudgingAction, type JudgingScope } from "../JudgingPanelShared";

type Draft = {
  name: string;
  entrySource: "ALL_SUBMITTED" | "ADVANCED";
  judgesSeeAll: boolean;
  freshEyes: boolean;
  reviewsPerProject: string;
  scoreNormalization: "RAW" | "ZSCORE";
  opensAt: string;
  closesAt: string;
};

function draftFor(round: JudgingDashboardRound | null, timezone: string): Draft {
  if (!round) return { name: "", entrySource: "ADVANCED", judgesSeeAll: false, freshEyes: false, reviewsPerProject: "", scoreNormalization: "RAW", opensAt: "", closesAt: "" };
  const local = (iso: string | null) => (iso ? zonedDatetimeLocalValue(new Date(iso), timezone) : "");
  return {
    name: round.name,
    entrySource: round.entrySource,
    judgesSeeAll: round.judgesSeeAll,
    freshEyes: round.freshEyes,
    reviewsPerProject: round.reviewsPerProject?.toString() ?? "",
    scoreNormalization: round.scoreNormalization,
    opensAt: local(round.opensAt),
    closesAt: local(round.closesAt),
  };
}

/**
 * Add a round, or change one's settings (docs/HACKATHON.md "Rounds"). The
 * server decides what may change: which projects a round judges is fixed
 * once it opens, and the first round always takes every submitted project.
 */
export function RoundSettingsDialog({
  scope,
  round,
  open,
  onOpenChange,
  timezone,
  nameMax,
}: {
  scope: JudgingScope;
  /** Null to add a round. */
  round: JudgingDashboardRound | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timezone: string;
  nameMax: number;
}) {
  const { run, busy } = useJudgingAction();
  const [draft, setDraft] = useState<Draft>(() => draftFor(round, timezone));
  const [errors, setErrors] = useState<Record<string, string[]> | undefined>();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const first = round?.position === 1;
  const sourceLocked = Boolean(round && (first || round.status !== "DRAFT" || round.finalists > 0));

  function save() {
    const instant = (value: string) => (value ? zonedInputToIso(value, timezone) ?? "" : "");
    const payload = { ...draft, opensAt: instant(draft.opensAt), closesAt: instant(draft.closesAt) };
    run(
      "save",
      () => (round ? editJudgingRound({ ...scope, roundId: round.id, round: payload }) : addJudgingRound({ ...scope, round: payload })),
      round ? "Round updated." : "Round added.",
      (result) => {
        if (result.ok) onOpenChange(false);
        else setErrors(result.fieldErrors);
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy === "save" ? undefined : onOpenChange(next))}>
      <DialogContent size="md">
        <DialogHeader title={round ? `Edit ${round.name}` : "Add a round"} description="Each round has its own rubric, judges and assignments." />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogBody className="flex flex-col gap-3.5">
            <Field label="Name" error={fieldError(errors, "name")}>
              <Input value={draft.name} maxLength={nameMax} required placeholder="Finals" onChange={(event) => set("name", event.target.value)} />
            </Field>
            <Field label="Projects judged" helperText={first ? "The first round always judges every submitted project." : "Finalists are advanced from the round before this one."} error={fieldError(errors, "entrySource")}>
              <Dropdown value={draft.entrySource} disabled={sourceLocked} onChange={(event) => set("entrySource", event.target.value as Draft["entrySource"])}>
                <option value="ADVANCED">Finalists advanced from the previous round</option>
                <option value="ALL_SUBMITTED">Every submitted project</option>
              </Dropdown>
            </Field>
            <Field label="Target judges per project" optional helperText="1 to 20. Leave empty for the default of 3." error={fieldError(errors, "reviewsPerProject")}>
              <Input type="number" inputMode="numeric" min={1} max={20} step={1} value={draft.reviewsPerProject} onChange={(event) => set("reviewsPerProject", event.target.value)} />
            </Field>
            <SwitchRow label="All judges see all projects" description="Off: judges see only the projects assigned to them in this round." checked={draft.judgesSeeAll} onCheckedChange={(on) => set("judgesSeeAll", on)} />
            <SwitchRow label="Fresh eyes" description="A judge never sees or gets a project they reviewed in an earlier round." checked={draft.freshEyes} onCheckedChange={(on) => set("freshEyes", on)} />
            <SwitchRow
              label="Adjust for harsh/generous judges"
              description="Rank this round by each judge's scores relative to their own average."
              checked={draft.scoreNormalization === "ZSCORE"}
              onCheckedChange={(on) => set("scoreNormalization", on ? "ZSCORE" : "RAW")}
            />
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <Field label={`Planned start (${timezone})`} optional error={fieldError(errors, "opensAt")}>
                <Input type="datetime-local" value={draft.opensAt} onChange={(event) => set("opensAt", event.target.value)} />
              </Field>
              <Field label={`Planned end (${timezone})`} optional error={fieldError(errors, "closesAt")}>
                <Input type="datetime-local" value={draft.closesAt} onChange={(event) => set("closesAt", event.target.value)} />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" disabled={busy === "save"} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy === "save"} loadingLabel="Saving…">
              {round ? "Save round" : "Add round"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
