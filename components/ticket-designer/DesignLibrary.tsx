"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Star, Trash2 } from "lucide-react";
import { assignTicketDesignAction, createTicketDesignAction, deleteTicketDesignAction } from "@/app/actions/ticket-designs";
import { ConfirmationDialog } from "@/components/feedback/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import { Callout, Chip } from "@/components/ui/display";
import { Dropdown, Field, Input } from "@/components/ui/field";

/**
 * The organisation's ticket design library (docs/TICKET_DESIGNER.md): new
 * designs from a starter, the default every event uses until it picks its
 * own, and deleting old ones.
 */
export function DesignLibrary({ organisationSlug, designs, defaultId, starters }: {
  organisationSlug: string;
  designs: Array<{ id: string; name: string; updatedAt: string; }>;
  defaultId: string | null;
  starters: Array<{ key: string; label: string; }>;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [starter, setStarter] = useState(starters[0]?.key ?? "classic");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string; } | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (task: () => Promise<{ ok: boolean; error?: string; data?: unknown; }>, after?: (data: unknown) => void) => {
    setError(null);
    startTransition(async () => {
      const result = await task();
      if (!result.ok) return setError(result.error ?? "Couldn't save that.");
      after?.(result.data);
      router.refresh();
    });
  };
  return (
    <div className="flex flex-col gap-6">
      {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      <form
        className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-5 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          run(() => createTicketDesignAction({ organisationSlug, name: name || "Ticket design", starter }), (data) => router.push(`/dashboard/${organisationSlug}/ticket-designs/${(data as { id: string; }).id}`));
        }}
      >
        <Field label="Name" className="flex-1"><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Hackathon ticket" /></Field>
        <Field label="Start from">
          <Dropdown value={starter} onChange={(event) => setStarter(event.target.value)}>
            {starters.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </Dropdown>
        </Field>
        <Button type="submit" startIcon={<Plus aria-hidden />} loading={pending} loadingLabel="Creating…">New design</Button>
      </form>
      {designs.length === 0 ? (
        <p className="text-body-ui text-ink-muted">No designs yet. Tickets use the built-in Classic design until you make one.</p>
      ) : (
        <ul aria-label="Ticket designs" className="flex flex-col divide-y divide-line rounded-xl border border-line bg-panel">
          {designs.map((design) => (
            <li key={design.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-body-ui font-semibold text-ink">{design.name}</p>
                <p className="text-caption text-ink-muted">Edited {new Date(design.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</p>
              </div>
              {design.id === defaultId ? <Chip tone="success" size="sm">Default</Chip> : (
                <Button size="sm" variant="quiet" startIcon={<Star aria-hidden />} disabled={pending} onClick={() => run(() => assignTicketDesignAction({ organisationSlug, target: "default", designId: design.id }))}>Make default</Button>
              )}
              <Button asChild size="sm" variant="secondary"><Link href={`/dashboard/${organisationSlug}/ticket-designs/${design.id}`}><Pencil aria-hidden className="size-4" />Edit</Link></Button>
              <Button size="sm" variant="quiet" startIcon={<Trash2 aria-hidden />} disabled={pending} onClick={() => setDeleting(design)}>Delete</Button>
            </li>
          ))}
        </ul>
      )}
      {defaultId ? (
        <div><Button variant="quiet" disabled={pending} onClick={() => run(() => assignTicketDesignAction({ organisationSlug, target: "default", designId: null }))}>Go back to the built-in design as the default</Button></div>
      ) : null}
      <ConfirmationDialog
        open={Boolean(deleting)}
        title={`Delete ${deleting?.name ?? "this design"}?`}
        message="Events that copied it keep their copies. If it's the default, tickets go back to the built-in design."
        confirmLabel="Delete design"
        onCancel={() => setDeleting(null)}
        onConfirm={() => { const target = deleting; setDeleting(null); if (target) run(() => deleteTicketDesignAction({ organisationSlug, designId: target.id })); }}
      />
    </div>
  );
}
