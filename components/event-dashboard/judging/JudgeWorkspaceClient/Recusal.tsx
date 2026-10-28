"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setJudgeRecusalAction } from "@/app/actions/judging";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/display";
import { ConfirmDialog } from "@/components/ui/dialog";
import type { Scope } from "./types";

/*
 * Judge self-recusal (docs/HACKATHON.md "Recusal"): step away from an
 * assigned project in the open round, and undo it. The server
 * (app/actions/judging.ts, lib/core/judging/recusal.ts) decides who may.
 */

/** "Recuse myself" on the scoring view, with a confirmation. */
export function RecuseButton({ scope, submissionId, title, onRecused }: { scope: Scope; submissionId: string; title: string; onRecused: () => void }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const res = await setJudgeRecusalAction({ ...scope, submissionId, recused: true });
      if (!res.ok) {
        showToast(res.error, "error");
        return;
      }
      setOpen(false);
      showToast(`You recused yourself from “${title}”.`, "success");
      router.refresh();
      onRecused();
    });
  }

  return (
    <>
      <Button type="button" variant="ghost" onClick={() => setOpen(true)} disabled={pending}>
        Recuse myself
      </Button>
      <ConfirmDialog
        open={open}
        title="Recuse yourself from this project?"
        message="It leaves your list and the organisers see that you stepped away, so another judge can review it. You can undo this while judging is open."
        confirmLabel="Recuse myself"
        destructive={false}
        loading={pending}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/** The projects this judge recused from in the round, each with "Undo". */
export function RecusedProjects({ scope, recusals, canUndo }: { scope: Scope; recusals: Array<{ submissionId: string; title: string }>; canUndo: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  if (recusals.length === 0) return null;

  function undo(submissionId: string) {
    setPendingId(submissionId);
    startTransition(async () => {
      const res = await setJudgeRecusalAction({ ...scope, submissionId, recused: false });
      setPendingId(null);
      if (!res.ok) {
        showToast(res.error, "error");
        return;
      }
      showToast("The project is back in your list.", "success");
      router.refresh();
    });
  }

  return (
    <Card padding="sm" className="flex flex-col gap-2.5">
      <h3 className="text-label text-ink">Recused</h3>
      <p className="text-caption text-ink-muted">You stepped away from these projects. They don&apos;t count towards your reviews.</p>
      <ul className="flex flex-col divide-y divide-line">
        {recusals.map((row) => (
          <li key={row.submissionId} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0 truncate text-body-ui text-ink">{row.title}</span>
            {canUndo ? (
              <Button type="button" variant="secondary" size="sm" loading={pendingId === row.submissionId} disabled={pendingId !== null} onClick={() => undo(row.submissionId)}>
                Undo
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
