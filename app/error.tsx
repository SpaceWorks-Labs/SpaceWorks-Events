"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/reportClientError.client";
import { Button } from "@/components/ui/button";

// `retry` re-fetches the segment; `reset` would re-render the same failed
// payload (for example a stream cut mid-way) and fail again.
export default function ErrorBoundary({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    if (process.env.NODE_ENV === "development") console.error("[ui] route error", error);
    else console.error("[ui] route error");
    reportClientError("route", error);
  }, [error]);
  return (
    <div className="mx-auto flex max-w-[520px] flex-col items-center gap-4 px-4 py-16 text-center">
      <span aria-hidden className="relative mb-2 block size-16">
        <span className="absolute inset-0 rounded-[16px] bg-sw-sky" />
        <span className="absolute -right-2 -top-2 size-7 rounded-full bg-sw-citron" />
      </span>
      <h1 className="text-h1 text-ink">We couldn’t load this page.</h1>
      <p className="text-body-ui text-ink-secondary">Try again. If it keeps happening, let the team that runs this Space Works Events site know.</p>
      <Button variant="primary" onClick={() => retry()}>Try again</Button>
    </div>
  );
}
