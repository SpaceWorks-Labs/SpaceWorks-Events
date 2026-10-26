"use client";

import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, Circle, Copy, Eye, Image as ImageIcon, Minus, Redo2, Square, Trash2, Type, Undo2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Dropdown } from "@/components/ui/field";
import { MERGE_FIELDS } from "@/lib/ticketDesign/fields";
import type { Alignment } from "./geometry";
import type { SaveStatus } from "./useDesignState";

/** Add elements, undo/redo, duplicate, delete, align and preview (docs/TICKET_DESIGNER.md). */
export function Toolbar(props: {
  onAdd: (kind: "text" | "rect" | "ellipse" | "line") => void;
  onAddField: (field: string) => void;
  onAddImage: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  selection: { canDelete: boolean; } | null;
  onDuplicate: () => void;
  onDelete: () => void;
  onAlign: (alignment: Alignment) => void;
  onPreview: () => void;
  status: SaveStatus;
}) {
  const { selection } = props;
  const aligns: Array<[Alignment, string, typeof AlignStartVertical]> = [
    ["left", "Align left", AlignStartVertical], ["center", "Centre horizontally", AlignCenterVertical], ["right", "Align right", AlignEndVertical],
    ["top", "Align top", AlignStartHorizontal], ["middle", "Centre vertically", AlignCenterHorizontal], ["bottom", "Align bottom", AlignEndHorizontal],
  ];
  const { status } = props;
  const statusText = "message" in status ? status.message : status.state === "saved" ? "Saved" : status.state === "saving" ? "Saving…" : "Unsaved changes";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel p-2">
      <Button size="sm" variant="secondary" startIcon={<Type aria-hidden />} onClick={() => props.onAdd("text")}>Text</Button>
      <Dropdown aria-label="Add a field" value="" onChange={(event) => { if (event.target.value) props.onAddField(event.target.value); }} className="w-40">
        <option value="">Add a field…</option>
        {MERGE_FIELDS.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
      </Dropdown>
      <IconButton size="sm" variant="secondary" label="Add an image" onClick={props.onAddImage}><ImageIcon /></IconButton>
      <IconButton size="sm" variant="secondary" label="Add a rectangle" onClick={() => props.onAdd("rect")}><Square /></IconButton>
      <IconButton size="sm" variant="secondary" label="Add an ellipse" onClick={() => props.onAdd("ellipse")}><Circle /></IconButton>
      <IconButton size="sm" variant="secondary" label="Add a line" onClick={() => props.onAdd("line")}><Minus /></IconButton>
      <span aria-hidden className="mx-1 h-6 w-px bg-line" />
      <IconButton size="sm" variant="quiet" label="Undo" disabled={!props.canUndo} onClick={props.onUndo}><Undo2 /></IconButton>
      <IconButton size="sm" variant="quiet" label="Redo" disabled={!props.canRedo} onClick={props.onRedo}><Redo2 /></IconButton>
      <IconButton size="sm" variant="quiet" label="Duplicate" disabled={!selection?.canDelete} onClick={props.onDuplicate}><Copy /></IconButton>
      <IconButton size="sm" variant="quiet" label="Delete" disabled={!selection?.canDelete} onClick={props.onDelete}><Trash2 /></IconButton>
      <span aria-hidden className="mx-1 h-6 w-px bg-line" />
      {aligns.map(([alignment, label, Icon]) => (
        <IconButton key={alignment} size="sm" variant="quiet" label={label} disabled={!selection} onClick={() => props.onAlign(alignment)}><Icon /></IconButton>
      ))}
      <span className="ml-auto text-caption text-ink-muted" role="status" aria-live="polite">{statusText}</span>
      <Button size="sm" variant="primary" startIcon={<Eye aria-hidden />} onClick={props.onPreview}>Preview</Button>
    </div>
  );
}
