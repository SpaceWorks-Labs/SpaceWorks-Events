"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyRoundFinalists, previewRoundFinalists } from "@/app/actions/judging-rounds";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/button";
import { CheckboxField, SegmentedControl } from "@/components/ui/choice";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Callout } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/field";
import type { AdvancementPreviewDto } from "@/lib/core/judgingRounds";
import type { JudgingDashboardRound } from "@/lib/eventDashboard/judgingRounds";
import { formatScore, type JudgingScope } from "../JudgingPanelShared";
import { advanceSummary } from "../judgingRoundsCopy";

type Mode = "top" | "pick";

/**
 * Advance finalists into an ADVANCED round (docs/HACKATHON.md "Rounds"):
 * the top N of the previous, finalised round's ranking, or hand-picked
 * projects. Preview writes nothing; Apply re-plans under the event lock and
 * refuses a plan that changed since the preview. Disqualified and withdrawn
 * projects are never offered.
 */
export function AdvanceFinalistsDialog({ scope, round, open, onOpenChange }: { scope: JudgingScope; round: JudgingDashboardRound; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">{open ? <AdvanceForm scope={scope} round={round} onDone={() => onOpenChange(false)} /> : null}</DialogContent>
    </Dialog>
  );
}

function AdvanceForm({ scope, round, onDone }: { scope: JudgingScope; round: JudgingDashboardRound; onDone: () => void }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [mode, setMode] = useState<Mode>("top");
  const [count, setCount] = useState("10");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<AdvancementPreviewDto | null>(null);
  const [candidates, setCandidates] = useState<AdvancementPreviewDto["candidates"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Hand-picking starts from the ranking a first preview loads.
  const plan = () => (mode === "top" || candidates.length === 0 ? { mode: "top" as const, count: count.trim() } : { mode, submissionIds: [...picked] });
  const reset = () => {
    setPreview(null);
    setError(null);
  };

  function runPreview() {
    setError(null);
    startTransition(async () => {
      const res = await previewRoundFinalists({ ...scope, roundId: round.id, plan: plan() });
      if (!res.ok || !res.data) {
        setError(res.ok ? "Couldn't preview the finalists. Try again." : res.error);
        setPreview(null);
        return;
      }
      setPreview(res.data);
      setCandidates(res.data.candidates);
      if (mode === "top") setPicked(new Set(res.data.finalists.map((row) => row.submissionId)));
    });
  }

  function runApply() {
    if (!preview) return;
    startTransition(async () => {
      const res = await applyRoundFinalists({ ...scope, roundId: round.id, plan: { ...plan(), fingerprint: preview.fingerprint } });
      if (!res.ok || !res.data) {
        setError(res.ok ? "Couldn't advance the finalists. Try again." : res.error);
        setPreview(null);
        return;
      }
      showToast(`${res.data.finalists} ${res.data.finalists === 1 ? "finalist" : "finalists"} in ${round.name}.`, "success");
      router.refresh();
      onDone();
    });
  }

  return (
    <>
      <DialogHeader title={`Advance finalists to ${round.name}`} description="Finalists come from the previous round's ranking. Scores and ranks stay private." />
      <DialogBody className="flex flex-col gap-4">
        <SegmentedControl<Mode>
          ariaLabel="How to choose finalists"
          value={mode}
          onValueChange={(next) => {
            setMode(next);
            reset();
          }}
          options={[
            { value: "top", label: "Top of the ranking" },
            { value: "pick", label: "Pick by hand" },
          ]}
        />
        {mode === "top" ? (
          <Field label="Number of finalists" helperText="The highest-ranked scored projects. Ties at the cut are flagged.">
            <Input type="number" inputMode="numeric" min={1} max={500} step={1} value={count} onChange={(event) => {
                setCount(event.target.value);
                reset();
              }} />
          </Field>
        ) : candidates.length === 0 ? (
          <Callout tone="info">Preview loads the ranking (starting from the top {count || "10"}), then tick or untick projects.</Callout>
        ) : (
          <fieldset className="flex max-h-72 flex-col gap-2 overflow-y-auto rounded-lg border border-line p-3">
            <legend className="sr-only">Finalists</legend>
            {candidates.map((row) => (
              <CheckboxField
                key={row.submissionId}
                label={`${row.rank ?? "—"}. ${row.title}`}
                description={`${row.entrantName} · ${formatScore(row.score)}`}
                checked={picked.has(row.submissionId)}
                onCheckedChange={(on) => {
                  setPicked((current) => {
                    const next = new Set(current);
                    if (on === true) next.add(row.submissionId);
                    else next.delete(row.submissionId);
                    return next;
                  });
                  reset();
                }}
              />
            ))}
          </fieldset>
        )}
        {error ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}
        {preview ? (
          <section aria-label="Preview" className="flex flex-col gap-2">
            <p role="status" className="text-body-ui font-semibold text-ink">
              From {preview.sourceRound.name}: {advanceSummary({ ...preview, finalists: preview.finalists.length })}
            </p>
            {preview.tieAtCutoff ? <Callout tone="warning">The next project below the cut has the same score as the last finalist. Pick by hand to include or leave out tied projects.</Callout> : null}
            {preview.awardWinnersRemoved > 0 ? (
              <Callout tone="warning">
                {preview.awardWinnersRemoved === 1 ? "1 award winner isn't" : `${preview.awardWinnersRemoved} award winners aren't`} among these finalists. Only the final round&apos;s finalists can win, so advancing removes {preview.awardWinnersRemoved === 1 ? "that winner" : "those winners"}.
              </Callout>
            ) : null}
            <ol className="flex max-h-60 flex-col divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {preview.finalists.map((row) => (
                <li key={row.submissionId} className="flex items-center justify-between gap-3 px-4 py-2 text-body-ui">
                  <span className="min-w-0 truncate">
                    <span className="font-semibold">{row.title}</span> <span className="text-caption text-ink-muted">{row.entrantName}</span>
                  </span>
                  <span className="shrink-0 text-caption tabular-nums text-ink-secondary">Rank {row.rank ?? "—"}</span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        {preview ? (
          <Button variant="primary" onClick={runApply} loading={pending} loadingLabel="Advancing…">
            Advance finalists
          </Button>
        ) : (
          <Button variant="primary" onClick={runPreview} loading={pending} loadingLabel="Previewing…" disabled={mode === "pick" && picked.size === 0 && candidates.length > 0}>
            Preview
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
