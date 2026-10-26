"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/feedback/ToastProvider";
import type { ChipTone } from "@/components/ui/display";

/** Small pieces shared by the Finance tab's client components (docs/FINANCE.md). */

export type FinanceScope = { organisationSlug: string; eventId: string; };

export const CLAIM_STATUS: Record<string, { label: string; tone: ChipTone; }> = {
  SUBMITTED: { label: "Waiting", tone: "warning" },
  APPROVED: { label: "Approved", tone: "accent" },
  PAID: { label: "Paid", tone: "success" },
  REJECTED: { label: "Rejected", tone: "danger" },
  WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
};

export const REQUEST_STATUS: Record<string, { label: string; tone: ChipTone; }> = {
  OPEN: { label: "Waiting", tone: "warning" },
  APPROVED: { label: "Refunded", tone: "success" },
  DECLINED: { label: "Declined", tone: "danger" },
  WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
};

/** Run a server action, show its error inline or a toast on success, then refresh the page. */
export function useSave() {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function save(task: () => Promise<{ ok: boolean; error?: string; }>, done: string, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await task();
      if (!result.ok) return setError(result.error ?? "Couldn't save that.");
      showToast(done, "success");
      after?.();
      router.refresh();
    });
  }
  return { pending, error, setError, save };
}
