import "server-only";

import type { EventPrivacyType } from "@prisma/client";
import { safeTimeZone } from "@/lib/timeZone";
import { cachedDateTimeFormat } from "@/lib/format/intlCache";

export const DAY_MS = 86_400_000;
export const PAGE_SIZE = 8;
export const SAMPLE_LIMIT = 5000;
export const LISTED = ["PUBLISHED", "HIDDEN"] as const;

export const INSIGHT_DAYS = 180;

export const PRIVACY_LABELS: Record<EventPrivacyType, string> = {
  PUBLIC: "Public",
  HIDDEN_LINK: "Hidden link",
  APPROVAL_REQUIRED: "Approval required",
  INVITE_ONLY: "Invite only",
};

/** "2026-10-15" for an instant in a timezone. */
export function localDay(date: Date, timeZone: string) {
  return cachedDateTimeFormat("en-CA", { timeZone: safeTimeZone(timeZone), year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function initialsOf(name: string | null | undefined) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
