"use client";

import { useState, useTransition } from "react";
import { Bookmark, Check, ChevronDown, Link2, Plus, Settings2, X } from "lucide-react";
import { deleteView, renameView, saveView, shareView } from "@/app/actions/saved-views";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/choice";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import {
  SAVED_VIEW_NAME_MAX_LENGTH,
  presetsFor,
  sameViewParams,
  viewLink,
  type SavedViewDto,
  type SavedViewSurfaceKey,
  type ViewParams,
} from "@/lib/savedViews";
import { ManageViewsDialog } from "./SavedViewsMenu/ManageViewsDialog";
import type { ActionResult } from "./SavedViewsMenu/types";

type Scope = { organisationSlug: string; eventId: string };

/**
 * The "Views" menu on an event-dashboard list (docs/FEATURES.md, "Saved
 * views"): built-in presets, the viewer's own views and views teammates
 * shared, then Save current view, Manage views and Copy link. Applying a view
 * only sets the list's filters; every list re-checks permission on the
 * server, so a view never shows anything its viewer couldn't see anyway.
 */
export function SavedViewsMenu({
  surface,
  scope,
  params,
  onApply,
  initialViews,
  teamMode = false,
}: {
  surface: SavedViewSurfaceKey;
  scope: Scope;
  /** The list's current filters (sanitised). */
  params: ViewParams;
  onApply: (params: ViewParams) => void;
  initialViews: readonly SavedViewDto[];
  teamMode?: boolean;
}) {
  const { showToast } = useToast();
  const [views, setViews] = useState<readonly SavedViewDto[]>(initialViews);
  // A server refresh brings a new list (someone shared or deleted a view): adopt it.
  const [seenInitial, setSeenInitial] = useState(initialViews);
  if (seenInitial !== initialViews) {
    setSeenInitial(initialViews);
    setViews(initialViews);
  }
  const [saving, setSaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const presets = presetsFor(surface, { teamMode });
  const mine = views.filter((view) => view.mine);
  const sharedWithMe = views.filter((view) => !view.mine);
  const filtered = Object.keys(params).length > 0;
  const active =
    presets.find((preset) => sameViewParams(surface, preset.params, params))?.label ??
    views.find((view) => sameViewParams(surface, view.params, params))?.name ??
    (filtered ? "Custom filters" : null);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(viewLink(window.location.href, surface, params));
      showToast("Link copied", "success");
    } catch {
      showToast("Could not copy", "error");
    }
  }

  const item = (key: string, label: string, viewParams: ViewParams, description?: string) => {
    const on = sameViewParams(surface, viewParams, params);
    return (
      <MenuItem key={key} onSelect={() => onApply(viewParams)} icon={on ? <Check /> : <span className="inline-block size-[18px]" />} description={description}>
        {label}
      </MenuItem>
    );
  };

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="secondary" size="sm" startIcon={<Bookmark />} endIcon={<ChevronDown />} aria-label={active ? `Views, showing ${active}` : "Views"}>
            <span className="max-w-[180px] truncate">{active ? `Views · ${active}` : "Views"}</span>
          </Button>
        </MenuTrigger>
        <MenuContent className="max-h-[min(70vh,520px)] w-[280px] overflow-y-auto">
          <MenuLabel>Presets</MenuLabel>
          {item("all", "All", {})}
          {presets.map((preset) => item(`preset:${preset.id}`, preset.label, preset.params))}
          {mine.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuLabel>Your views</MenuLabel>
              {mine.map((view) => item(`view:${view.id}`, view.name, view.params, view.shared ? "Shared" : undefined))}
            </>
          ) : null}
          {sharedWithMe.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuLabel>Shared views</MenuLabel>
              {sharedWithMe.map((view) => item(`view:${view.id}`, view.name, view.params, `By ${view.createdBy}`))}
            </>
          ) : null}
          <MenuSeparator />
          <MenuItem icon={<Plus />} disabled={!filtered} onSelect={() => setSaving(true)} description={filtered ? undefined : "Pick some filters first"}>
            Save current view…
          </MenuItem>
          {views.length > 0 ? (
            <MenuItem icon={<Settings2 />} onSelect={() => setManaging(true)}>
              Manage views…
            </MenuItem>
          ) : null}
          <MenuItem icon={<Link2 />} onSelect={() => void copyLink()}>
            Copy link
          </MenuItem>
          {filtered ? (
            <MenuItem icon={<X />} onSelect={() => onApply({})}>
              Clear filters
            </MenuItem>
          ) : null}
        </MenuContent>
      </Menu>

      <SaveViewDialog
        open={saving}
        onOpenChange={setSaving}
        onSave={async (name, shared) => {
          const res = (await saveView({ ...scope, surface, name, params, shared })) as ActionResult;
          if (res.ok && res.data) {
            setViews(res.data.views);
            showToast(shared ? "View saved and shared" : "View saved", "success");
          }
          return res;
        }}
      />

      <ManageViewsDialog
        open={managing}
        onOpenChange={setManaging}
        views={views}
        run={async (action) => {
          const res = (await action()) as ActionResult;
          if (!res.ok) {
            showToast(res.error, "error");
            return res;
          }
          if (res.data) setViews(res.data.views);
          return res;
        }}
        rename={(view, name) => renameView({ ...scope, surface, viewId: view.id, name })}
        share={(view, shared) => shareView({ ...scope, surface, viewId: view.id, shared })}
        remove={(view) => deleteView({ ...scope, surface, viewId: view.id })}
      />
    </>
  );
}

function SaveViewDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, shared: boolean) => Promise<ActionResult>;
}) {
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  function close(next: boolean) {
    if (pending) return;
    if (!next) {
      setName("");
      setShared(false);
      setError(undefined);
    }
    onOpenChange(next);
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="sm">
        <DialogHeader title="Save view" description="Save these filters and search so you can come back to them in one click." />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError(undefined);
            startTransition(async () => {
              const res = await onSave(name, shared);
              if (!res.ok) {
                setError(res.fieldErrors?.name?.[0] ?? res.error);
                return;
              }
              setName("");
              setShared(false);
              onOpenChange(false);
            });
          }}
        >
          <DialogBody className="flex flex-col gap-4">
            <Field label="Name" error={error} helperText={`Up to ${SAVED_VIEW_NAME_MAX_LENGTH} characters.`}>
              <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={SAVED_VIEW_NAME_MAX_LENGTH} autoComplete="off" autoFocus required />
            </Field>
            <CheckboxField
              label="Share with the team"
              description="Everyone who can open this list on this event will see the view. It never gives anyone more access."
              checked={shared}
              onCheckedChange={(value) => setShared(value === true)}
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => close(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={pending} loadingLabel="Saving…" disabled={!name.trim()}>
              Save view
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
