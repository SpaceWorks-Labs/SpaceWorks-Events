"use client";

import { RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format/datetime";
import type { DeskResult } from "./types";

/** The last scan or check-in: success, already collected, or refused with "Admit anyway". */
export function ResultPanel({ result, listName, timeZone, pending, onNext, onUndo, onForce }: {
  result: DeskResult;
  listName: string;
  timeZone: string;
  pending: boolean;
  onNext: () => void;
  onUndo: (rsvpId: string, displayName: string) => void;
  onForce: (retry: { rawInput?: string; rsvpId?: string }) => void;
}) {
  if (result.kind === "refused") {
    return (
      <section data-testid="list-result" className={cn("flex flex-col gap-3 rounded-xl p-6", result.needsForce ? "border-2 border-warning-solid bg-warning-bg text-warning-fg" : "bg-danger-bg text-danger-fg")}>
        <p className="text-[15px] font-semibold">{result.needsForce ? "On the waitlist" : `Not added to ${listName}`}</p>
        <p className="text-body-ui">{result.message}</p>
        <div className="flex flex-wrap gap-2">
          {result.needsForce && result.retry ? (
            <Button size="sm" variant="primary" onClick={() => onForce(result.retry!)} disabled={pending}>Admit anyway</Button>
          ) : null}
          <Button size="sm" variant="secondary" startIcon={<X />} onClick={onNext}>Scan again</Button>
        </div>
      </section>
    );
  }
  const success = result.kind === "success";
  return (
    <section data-testid="list-result" className={cn("flex flex-col gap-3 rounded-xl p-6", success ? "bg-success-solid text-white" : "bg-emphasis text-ink")}>
      <p className="text-[15px] font-semibold">{success ? `Checked in to ${listName} at ${formatTime(result.checkedInAt, timeZone)}` : result.message}</p>
      <p className="break-words font-display text-[30px] font-extrabold leading-none tracking-[-0.03em]">{result.displayName}</p>
      {result.email ? <p className="text-sm opacity-90">{result.email}</p> : null}
      <div className="mt-1 flex flex-wrap gap-2">
        <Button size="sm" variant={success ? "inverse" : "secondary"} startIcon={<X />} onClick={onNext}>Next guest</Button>
        <Button size="sm" variant={success ? "inverse" : "quiet"} startIcon={<RotateCcw />} onClick={() => onUndo(result.rsvpId, result.displayName)} disabled={pending}>Undo</Button>
      </div>
    </section>
  );
}
