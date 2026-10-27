"use client";

import { useEffect } from "react";
import { catchError, type ErrorInfo } from "next/error";
import { Button } from "@/components/ui/button";
import { reportClientError } from "@/lib/reportClientError.client";

/**
 * One event dashboard tab that failed to render. Every panel streams in as
 * its own part of the page, so a dropped connection can break one tab while
 * the rest arrived; this keeps the failure inside that tab, and "Try again"
 * re-fetches the page instead of re-rendering the broken part. notFound() and
 * redirect() still pass through (catchError leaves them alone).
 */
function PanelError({ label }: { label: string }, { error, retry }: ErrorInfo) {
  return <PanelErrorMessage label={label} error={error} retry={retry} />;
}

function PanelErrorMessage({ label, error, retry }: { label: string; error: unknown; retry: () => void }) {
  useEffect(() => {
    if (process.env.NODE_ENV === "development") console.error("[ui] panel error", error);
    else console.error("[ui] panel error");
    reportClientError("panel", error instanceof Error ? error : new Error(String(error)));
  }, [error]);
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-line bg-panel p-6">
      <p className="text-body-ui text-ink">We couldn’t load {label}. Check your connection and try again.</p>
      <Button variant="secondary" onClick={() => retry()}>Try again</Button>
    </div>
  );
}

export const PanelErrorBoundary = catchError(PanelError);
