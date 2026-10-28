"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { restoreRsvp } from "@/app/actions/rsvp-admin";
import { useToast } from "@/components/feedback/ToastProvider";
import type { Result } from "./constants";

/** Runs a team action with a toast, optionally offering Undo, and refreshes the page. */
export function useTeamActions(organisationSlug: string) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  function run(id: string, action: () => Promise<Result>, success: string) {
    setBusyId(id);
    startTransition(async () => {
      const res = await action();
      setBusyId(null);
      if (!res.ok) {
        showToast(res.error, "error");
        return;
      }
      showToast(success, "success");
      router.refresh();
    });
  }

  function withUndo(id: string, action: () => Promise<{ ok: true; data?: { undoId: string } } | { ok: false; error: string }>, success: string, restored: string) {
    setBusyId(id);
    startTransition(async () => {
      const res = await action();
      setBusyId(null);
      if (!res.ok) {
        showToast(res.error, "error");
        return;
      }
      const undoId = res.data?.undoId;
      showToast(
        success,
        "success",
        undoId
          ? {
              label: "Undo",
              onClick: () => {
                startTransition(async () => {
                  const back = await restoreRsvp({ organisationSlug, undoId });
                  if (back.ok) {
                    showToast(restored, "success");
                    router.refresh();
                  } else {
                    showToast(back.error, "error");
                  }
                });
              },
            }
          : undefined,
        10000,
      );
      router.refresh();
    });
  }

  return { router, showToast, pending, busyId, run, withUndo };
}
