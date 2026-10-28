"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/reportClientError.client";

// Rendered without the app stylesheet, so brand colours are explicit here
// (Warm Cream page, Deep Ink text, Maker Teal action with a cream label).
const CREAM = "#FFF4E8";
const INK = "#142C2A";
const TEAL = "#006E63";

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    if (process.env.NODE_ENV === "development") console.error("[ui] global error", error);
    else console.error("[ui] global error");
    reportClientError("global", error);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100dvh", background: CREAM, color: INK, fontFamily: "system-ui, sans-serif" }}>
        <main style={{ maxWidth: 560, margin: "0 auto", padding: "clamp(3rem, 12vh, 7rem) 1.5rem", textAlign: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the app stylesheet and image pipeline may be what failed */}
          <img src="/brand/logo/lockup-horizontal.svg" alt="Space Works" width={180} style={{ display: "inline-block", height: "auto", marginBottom: "2.5rem" }} />
          <h1 style={{ margin: "0 0 .75rem", fontSize: 30, fontWeight: 600, lineHeight: 1.15 }}>We couldn’t load this page.</h1>
          <p style={{ margin: "0 0 1.75rem", fontSize: 17, lineHeight: 1.55 }}>Try again. If it keeps happening, let the team that runs this Space Works Events site know.</p>
          <button type="button" onClick={() => retry()} style={{ minHeight: 44, border: 0, borderRadius: 10, padding: ".75rem 1.25rem", color: CREAM, background: TEAL, fontSize: 16, fontWeight: 600, cursor: "pointer" }}>Try again</button>
        </main>
      </body>
    </html>
  );
}
