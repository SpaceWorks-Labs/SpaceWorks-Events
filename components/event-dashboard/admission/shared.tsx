"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AdmissionStatus } from "@prisma/client";
import { useToast } from "@/components/feedback/ToastProvider";
import type { ChipTone } from "@/components/ui/display";
import type { AdmissionDashboard } from "@/lib/admission/dashboard";

/** Shared client pieces of the Applications tab (docs/ADMISSION.md). */

export type AdmissionScope = { organisationSlug: string; eventId: string };
export type AdmissionData = AdmissionDashboard;
export type ApplicationRow = AdmissionDashboard["applications"][number];
export type StageRow = AdmissionDashboard["stages"][number];

type Outcome = { ok: true; data?: unknown } | { ok: false; error: string };

export const STATUS_TONES: Record<AdmissionStatus, ChipTone> = {
  IN_REVIEW: "info",
  OFFERED: "accent",
  WAITLISTED: "warning",
  ACCEPTED: "success",
  REJECTED: "neutral",
  DECLINED: "neutral",
  EXPIRED: "neutral",
  WITHDRAWN: "neutral",
};

/** Run an action with a busy key, a toast and a refresh, the same way the Judging tab does. */
export function useAdmissionAction() {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  function run(key: string, action: () => Promise<Outcome>, success: string | null | ((data: unknown) => string | null), after?: (result: Outcome) => void) {
    setBusy(key);
    startTransition(async () => {
      let result: Outcome;
      try {
        result = await action();
      } catch {
        result = { ok: false, error: "That didn't save. Check your connection and try again." };
      }
      setBusy(null);
      if (!result.ok) showToast(result.error, "error");
      else {
        const message = typeof success === "function" ? success(result.data) : success;
        if (message) showToast(message, "success");
        router.refresh();
      }
      after?.(result);
    });
  }

  return { run, busy: pending ? busy : null };
}

export function formatWhen(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-GB", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  }
}
