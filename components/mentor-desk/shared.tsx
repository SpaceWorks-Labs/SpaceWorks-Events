"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/feedback/ToastProvider";
import { Chip, type ChipTone } from "@/components/ui/display";
import { formatDayShort, formatTime } from "@/lib/format/datetime";

/** Small pieces shared by the Mentor Desk's client components (docs/MENTOR_DESK.md). */

export type DeskScope = { organisationSlug: string; eventId: string };
/** How a participant proves who they are: the team's management link, or their signed-in account. */
export type ParticipantRef = { manageToken: string } | DeskScope;

type Outcome = { ok: boolean; error?: string };

/** Runs a server action, shows its error inline or a toast on success, then refreshes the page. */
export function useDeskSave() {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function save<T extends Outcome>(task: () => Promise<T>, done: string, after?: (result: T) => void) {
    setError(null);
    startTransition(async () => {
      const result = await task();
      if (!result.ok) return setError(result.error ?? "That didn't save. Try again.");
      if (done) showToast(done, "success");
      after?.(result);
      router.refresh();
    });
  }
  return { pending, error, setError, save };
}

/** Re-reads the page every `seconds` while it is visible: the live queue polls instead of holding a socket. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => window.clearInterval(timer);
  }, [router, seconds]);
  return null;
}

export const HELP_STATUS: Record<string, { label: string; tone: ChipTone }> = {
  OPEN: { label: "Waiting", tone: "warning" },
  CLAIMED: { label: "Mentor on the way", tone: "accent" },
  RESOLVED: { label: "Resolved", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  EXPIRED: { label: "Expired", tone: "neutral" },
};

export function HelpStatusChip({ status, lapsed }: { status: string; lapsed?: boolean }) {
  if (lapsed) return <Chip tone="danger" size="sm">Claim lapsed</Chip>;
  const entry = HELP_STATUS[status] ?? { label: status, tone: "neutral" as ChipTone };
  return <Chip tone={entry.tone} size="sm">{entry.label}</Chip>;
}

/** "Today 14:30" style, in the event's own clock. */
export function When({ iso, timeZone }: { iso: string; timeZone: string }) {
  const date = new Date(iso);
  return <time dateTime={iso}>{formatDayShort(date, timeZone)} {formatTime(date, timeZone)}</time>;
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <p role="alert" className="text-caption text-danger-fg">{error}</p> : null;
}

/** Comma-separated tags, as typed in a single field. */
export function splitTags(value: string) {
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}
