"use client";

import { useEffect, useState } from "react";
import { loadRoundFinalistsList } from "@/app/actions/judging-rounds";
import { Callout, Chip, EmptyState } from "@/components/ui/display";
import { Spinner } from "@/components/ui/spinner";
import type { RoundFinalistDto } from "@/lib/core/judgingRounds";
import type { JudgingScope } from "../JudgingPanelShared";

/** One ADVANCED round's finalists, best previous rank first (organisers only). Reloads when the count changes after a refresh. */
export function FinalistsList({ scope, roundId, count }: { scope: JudgingScope; roundId: string; count: number }) {
  const [rows, setRows] = useState<RoundFinalistDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void loadRoundFinalistsList({ ...scope, roundId }).then((res) => {
      if (!current) return;
      if (res.ok && res.data) setRows(res.data);
      else setError(res.ok ? "Could not load the finalists." : res.error);
    });
    return () => {
      current = false;
    };
  }, [scope, roundId, count]);

  if (error) return <Callout tone="danger">{error}</Callout>;
  if (!rows) {
    return (
      <div className="flex justify-center py-4">
        <Spinner className="size-5" />
        <span className="sr-only">Loading the finalists</span>
      </div>
    );
  }
  if (rows.length === 0) return <EmptyState title="No finalists yet">Advance finalists from the previous round once it is finalised.</EmptyState>;
  return (
    <ol className="flex flex-col divide-y divide-line rounded-lg border border-line">
      {rows.map((row) => (
        <li key={row.submissionId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-body-ui">
          <span className="min-w-0">
            <span className="block truncate font-semibold">{row.title}</span>
            <span className="block truncate text-caption text-ink-muted">{row.entrantName}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {row.status !== "SUBMITTED" ? (
              <Chip size="sm" tone="danger">
                {row.status === "DISQUALIFIED" ? "Disqualified" : "Withdrawn"}
              </Chip>
            ) : null}
            <span className="text-caption tabular-nums text-ink-secondary">{row.sourceRank ? `Was ranked ${row.sourceRank}` : "Unranked"}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
