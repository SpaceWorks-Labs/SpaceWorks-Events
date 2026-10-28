"use client";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/display";
import { TBody, TD, TH, THead, TR, Table } from "@/components/ui/table";
import type { AutoAssignPreviewDto } from "@/lib/core/judgingOps";
import { autoAssignPreviewHeadline, autoAssignSeedLine, SEE_ALL_SWITCH_WARNING } from "../judgingOpsCopy";

/** The automatic assignment preview: per-judge loads, projects short of the target, and a RANDOM run's seed with "Re-roll". */
export function AutoAssignPreview({ preview, onReroll, busy }: { preview: AutoAssignPreviewDto; onReroll?: () => void; busy: boolean }) {
  return (
    <section aria-label="Preview" className="flex flex-col gap-3" data-testid="auto-assign-preview">
      <p role="status" className="text-body-ui font-semibold text-ink">
        {autoAssignPreviewHeadline(preview)}
      </p>
      {preview.judgesSeeAll ? <Callout tone="warning">{SEE_ALL_SWITCH_WARNING}</Callout> : null}
      {preview.seed ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-4 py-2.5">
          <p className="min-w-0 break-all text-caption text-ink-secondary">{autoAssignSeedLine(preview.seed)}</p>
          {onReroll ? (
            <Button variant="secondary" size="sm" onClick={onReroll} disabled={busy}>
              Re-roll
            </Button>
          ) : null}
        </div>
      ) : null}
      <Table label="Assignments per judge">
        <THead>
          <tr>
            <TH>Judge</TH>
            <TH className="text-right">Now</TH>
            <TH className="text-right">Change</TH>
            <TH className="text-right">After</TH>
          </tr>
        </THead>
        <TBody>
          {preview.judges.map((judge) => (
            <TR key={judge.userId}>
              <TD>
                <span className="block font-semibold">{judge.name}</span>
                <span className="block text-caption text-ink-muted">{judge.kind === "admin" ? "Organiser" : "Judge"}</span>
              </TD>
              <TD className="text-right tabular-nums">{judge.before}</TD>
              <TD className="whitespace-nowrap text-right tabular-nums">
                {judge.added ? `+${judge.added}` : ""}
                {judge.added && judge.removed ? " " : ""}
                {judge.removed ? `−${judge.removed}` : ""}
                {!judge.added && !judge.removed ? "—" : ""}
              </TD>
              <TD className="text-right font-semibold tabular-nums">{judge.after}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {preview.shortfallTotal > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-label text-ink">Projects short of {preview.perProject} judges</h3>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {preview.shortfalls.map((row) => (
              <li key={row.submissionId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-body-ui">
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{row.title}</span>
                  <span className="block truncate text-caption text-ink-muted">{row.entrantName}</span>
                </span>
                <span className="shrink-0 text-caption tabular-nums text-ink-secondary">
                  {row.assigned} of {preview.perProject}
                </span>
              </li>
            ))}
          </ul>
          {preview.shortfallTotal > preview.shortfalls.length ? (
            <p className="text-caption text-ink-muted">and {preview.shortfallTotal - preview.shortfalls.length} more.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
