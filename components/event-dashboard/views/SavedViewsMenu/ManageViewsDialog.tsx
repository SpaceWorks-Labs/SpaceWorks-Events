"use client";

import { useState, useTransition } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button, IconButton } from "@/components/ui/button";
import { Switch } from "@/components/ui/choice";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Chip, EmptyState } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/field";
import { SAVED_VIEW_NAME_MAX_LENGTH, type SavedViewDto } from "@/lib/savedViews";
import type { ActionResult } from "./types";

/** Rename, share or delete saved views, with a confirmation before deleting. */
export function ManageViewsDialog({
  open,
  onOpenChange,
  views,
  run,
  rename,
  share,
  remove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  views: readonly SavedViewDto[];
  run: (action: () => Promise<unknown>) => Promise<ActionResult>;
  rename: (view: SavedViewDto, name: string) => Promise<unknown>;
  share: (view: SavedViewDto, shared: boolean) => Promise<unknown>;
  remove: (view: SavedViewDto) => Promise<unknown>;
}) {
  const { showToast } = useToast();
  const [editing, setEditing] = useState<{ id: string; name: string; error?: string } | null>(null);
  const [deleting, setDeleting] = useState<SavedViewDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function act(key: string, action: () => Promise<unknown>, success?: string, after?: (res: ActionResult) => void) {
    setBusy(key);
    startTransition(async () => {
      const res = await run(action);
      setBusy(null);
      if (res.ok && success) showToast(success, "success");
      after?.(res);
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="md">
          <DialogHeader title="Manage views" description="Rename, share or delete your views. Owners and admins can also delete views others shared." />
          <DialogBody>
            {views.length === 0 ? (
              <EmptyState>No saved views yet.</EmptyState>
            ) : (
              <ul aria-label="Saved views" className="flex flex-col divide-y divide-line">
                {views.map((view) => (
                  <li key={view.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-3">
                    {editing?.id === view.id ? (
                      <form
                        className="flex min-w-0 flex-1 items-start gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          act(`rename:${view.id}`, () => rename(view, editing.name), "View renamed", (res) => {
                            if (res.ok) setEditing(null);
                            else setEditing({ ...editing, error: res.fieldErrors?.name?.[0] ?? res.error });
                          });
                        }}
                      >
                        <Field label={`New name for ${view.name}`} hideLabel error={editing.error} className="min-w-0 flex-1">
                          <Input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} maxLength={SAVED_VIEW_NAME_MAX_LENGTH} autoFocus />
                        </Field>
                        <Button type="submit" size="sm" variant="primary" loading={busy === `rename:${view.id}`} loadingLabel="Saving…" disabled={!editing.name.trim()}>
                          Save
                        </Button>
                        <Button size="sm" variant="quiet" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </form>
                    ) : (
                      <div className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-ink">{view.name}</span>
                        <span className="flex flex-wrap items-center gap-1.5 text-caption text-ink-muted">
                          {view.mine ? "Yours" : `By ${view.createdBy}`}
                          {view.shared ? (
                            <Chip size="sm" tone="accent">
                              Shared
                            </Chip>
                          ) : null}
                        </span>
                      </div>
                    )}
                    {editing?.id === view.id ? null : (
                      <div className="flex items-center gap-1.5">
                        {view.mine ? (
                          <>
                            <label className="flex items-center gap-2 text-caption text-ink-secondary">
                              <Switch
                                checked={view.shared}
                                disabled={busy != null}
                                aria-label={`Share ${view.name} with the team`}
                                onCheckedChange={(on) => act(`share:${view.id}`, () => share(view, on), on ? "View shared" : "View no longer shared")}
                              />
                              <span aria-hidden>Share</span>
                            </label>
                            <IconButton label={`Rename ${view.name}`} size="sm" onClick={() => setEditing({ id: view.id, name: view.name })} disabled={busy != null}>
                              <Pencil />
                            </IconButton>
                          </>
                        ) : null}
                        {view.canDelete ? (
                          <IconButton label={`Delete ${view.name}`} size="sm" variant="danger" onClick={() => setDeleting(view)} disabled={busy != null}>
                            <Trash2 />
                          </IconButton>
                        ) : null}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleting != null}
        title="Delete this view?"
        message={deleting ? (deleting.mine ? `"${deleting.name}" will be removed${deleting.shared ? " for everyone it was shared with" : ""}.` : `"${deleting.name}" was shared by ${deleting.createdBy}. It will be removed for everyone.`) : undefined}
        confirmLabel="Delete view"
        loading={deleting != null && busy === `delete:${deleting.id}`}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          const view = deleting;
          act(`delete:${view.id}`, () => remove(view), "View deleted", () => setDeleting(null));
        }}
      />
    </>
  );
}
