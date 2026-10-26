"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { saveTicketDesignAction, uploadTicketDesignImageAction } from "@/app/actions/ticket-designs";
import { Callout } from "@/components/ui/display";
import { Input } from "@/components/ui/field";
import type { DesignDocument, DesignElement } from "@/lib/ticketDesign/schema";
import { Canvas } from "./Canvas";
import { EDITOR_FONT_FACES } from "./ElementView";
import { alignToCanvas, duplicateElement, newElement, newElementId } from "./geometry";
import { CanvasInspector, ElementInspector } from "./Inspector";
import { LayersPanel } from "./LayersPanel";
import { PreviewDialog } from "./PreviewDialog";
import { Toolbar } from "./Toolbar";
import { useDesignState } from "./useDesignState";

/**
 * The Canva-style ticket designer (docs/TICKET_DESIGNER.md). Keyboard: arrows
 * nudge 0.5 mm (Shift: 5 mm), Delete removes, Ctrl/Cmd+Z / Shift+Z / Y undo
 * and redo, Ctrl/Cmd+C, V and D copy, paste and duplicate. Hold Alt while
 * dragging to turn snapping off.
 */
export function TicketDesigner({ designId, organisationSlug, name, initial, attendees }: {
  designId: string;
  organisationSlug: string;
  name: string;
  initial: DesignDocument;
  attendees: Array<{ id: string; label: string; }>;
}) {
  const [title, setTitle] = useState(name);
  const titleRef = useRef(name);
  const save = useCallback(async (document: DesignDocument) => saveTicketDesignAction({ organisationSlug, designId, document, name: titleRef.current }), [organisationSlug, designId]);
  const state = useDesignState(initial, save);
  const { document } = state;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const clipboard = useRef<DesignElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const replacing = useRef<string | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const [areaWidth, setAreaWidth] = useState(900);
  const scale = Math.max(1.5, Math.min(6, (areaWidth - 16) / document.widthMm));
  const selected = document.elements.find((element) => element.id === selectedId) ?? null;

  useEffect(() => {
    const node = area.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setAreaWidth(entry!.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Every edit is a function of the latest document, so slow work (an upload) never overwrites newer edits.
  const { apply } = state;
  const patch = useCallback((id: string, change: Partial<DesignElement>) => apply((current) => ({ ...current, elements: current.elements.map((element) => (element.id === id ? ({ ...element, ...change } as DesignElement) : element)) })), [apply]);
  const add = useCallback((element: DesignElement) => {
    apply((current) => ({ ...current, elements: [...current.elements, current.elements.some((other) => other.id === element.id) ? { ...element, id: newElementId(current, element.kind) } : element] }));
    setSelectedId(element.id);
  }, [apply]);
  const remove = useCallback((id: string) => { apply((current) => ({ ...current, elements: current.elements.filter((element) => element.id !== id || element.kind === "qr") })); setSelectedId(null); }, [apply]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select, [contenteditable]") || target.closest("[role=dialog]"))) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) state.redo(); else state.undo(); return; }
      if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); state.redo(); return; }
      if (mod && event.key.toLowerCase() === "v" && clipboard.current) { event.preventDefault(); add(duplicateElement(document, clipboard.current)); return; }
      if (!selected) return;
      if (mod && event.key.toLowerCase() === "c" && selected.kind !== "qr") { clipboard.current = selected; return; }
      if (mod && event.key.toLowerCase() === "d" && selected.kind !== "qr") { event.preventDefault(); add(duplicateElement(document, selected)); return; }
      if ((event.key === "Delete" || event.key === "Backspace") && selected.kind !== "qr") { event.preventDefault(); remove(selected.id); return; }
      const step = event.shiftKey ? 5 : 0.5;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const move = moves[event.key];
      if (move && !selected.locked) { event.preventDefault(); patch(selected.id, { x: Math.round((selected.x + move[0]) * 10) / 10, y: Math.round((selected.y + move[1]) * 10) / 10 }); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, document, selected, add, remove, patch]);

  async function upload(file: File) {
    setUploadError(null);
    const form = new FormData();
    form.set("organisationSlug", organisationSlug);
    form.set("designId", designId);
    form.set("file", file);
    const result = await uploadTicketDesignImageAction(form);
    if (!result.ok || !result.data) return setUploadError(result.ok ? "Couldn't upload that image." : result.error);
    if (replacing.current) patch(replacing.current, { url: result.data.url });
    else add(newElement(document, "image", { url: result.data.url }));
    replacing.current = null;
  }

  async function preview() {
    if (await state.saveNow()) setPreviewing(String(Date.now()));
  }

  return (
    <div className="flex flex-col gap-4">
      <style>{EDITOR_FONT_FACES}</style>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-label text-ink">
          Design name
          <Input value={title} maxLength={80} onChange={(event) => { setTitle(event.target.value); titleRef.current = event.target.value; }} onBlur={() => void state.saveNow(true)} />
        </label>
      </div>
      <Toolbar
        onAdd={(kind) => add(newElement(document, kind))}
        onAddField={(field) => add(newElement(document, "field", { field }))}
        onAddImage={() => { replacing.current = null; fileInput.current?.click(); }}
        onUndo={state.undo} onRedo={state.redo} canUndo={state.canUndo} canRedo={state.canRedo}
        selection={selected ? { canDelete: selected.kind !== "qr" } : null}
        onDuplicate={() => selected && add(duplicateElement(document, selected))}
        onDelete={() => selected && remove(selected.id)}
        onAlign={(alignment) => selected && patch(selected.id, alignToCanvas(selected, document, alignment))}
        onPreview={() => void preview()}
        status={state.status}
      />
      {uploadError ? <Callout tone="danger" role="alert">{uploadError}</Callout> : null}
      {state.status.state === "invalid" ? <Callout tone="warning" role="status">{state.status.message}</Callout> : null}
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} aria-hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div ref={area} className="min-w-0 overflow-auto rounded-xl border border-line bg-subtle p-2">
          <Canvas document={document} scale={scale} selectedId={selectedId} onSelect={setSelectedId} onDraft={state.draft} onRelease={state.endDraft} />
        </div>
        <aside className="flex flex-col gap-6">
          {selected ? (
            <ElementInspector key={selected.id} element={selected} onChange={(change) => patch(selected.id, change)} onReplaceImage={() => { replacing.current = selected.id; fileInput.current?.click(); }} />
          ) : (
            <CanvasInspector document={document} onChange={(change) => apply((current) => ({ ...current, ...change }))} />
          )}
          <LayersPanel
            elements={document.elements}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onToggle={(id, flag) => { const element = document.elements.find((candidate) => candidate.id === id); if (element) patch(id, { [flag]: !element[flag] || undefined }); }}
            onMove={(id, direction) => apply((current) => {
              const index = current.elements.findIndex((element) => element.id === id);
              const target = index + direction;
              if (index < 0 || target < 0 || target >= current.elements.length) return current;
              const elements = [...current.elements];
              [elements[index], elements[target]] = [elements[target]!, elements[index]!];
              return { ...current, elements };
            })}
          />
        </aside>
      </div>
      {previewing ? <PreviewDialog designId={designId} organisationSlug={organisationSlug} version={previewing} attendees={attendees} onClose={() => setPreviewing(null)} /> : null}
    </div>
  );
}
