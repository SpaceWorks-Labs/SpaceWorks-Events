"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/cn";
import type { DesignDocument, DesignElement } from "@/lib/ticketDesign/schema";
import { boxStyle, ElementView } from "./ElementView";
import { snapBox, snapTargets, type Box, type Guide } from "./geometry";

/**
 * The design surface (docs/TICKET_DESIGNER.md): click to select, drag to move
 * (snapping to the canvas and other elements, with guides), corner and edge
 * handles to resize, the top handle to rotate (in 15° steps near them).
 * Changes stream as a draft and land in history once, on release.
 */

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
type Gesture =
  | { kind: "move"; id: string; start: { x: number; y: number; }; origin: Box; }
  | { kind: "resize"; id: string; handle: Handle; start: { x: number; y: number; }; origin: Box; }
  | { kind: "rotate"; id: string; centre: { x: number; y: number; }; };

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_POSITION: Record<Handle, string> = {
  nw: "-left-1.5 -top-1.5 cursor-nwse-resize", n: "left-1/2 -top-1.5 -translate-x-1/2 cursor-ns-resize", ne: "-right-1.5 -top-1.5 cursor-nesw-resize",
  e: "-right-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize", se: "-right-1.5 -bottom-1.5 cursor-nwse-resize", s: "left-1/2 -bottom-1.5 -translate-x-1/2 cursor-ns-resize",
  sw: "-left-1.5 -bottom-1.5 cursor-nesw-resize", w: "-left-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize",
};
const MIN_MM = 2;
const round = (value: number) => Math.round(value * 10) / 10;

function resized(origin: Box, handle: Handle, dx: number, dy: number, square: boolean): Box {
  let { x, y, w, h } = origin;
  if (handle.includes("e")) w = Math.max(MIN_MM, origin.w + dx);
  if (handle.includes("s")) h = Math.max(MIN_MM, origin.h + dy);
  if (handle.includes("w")) { w = Math.max(MIN_MM, origin.w - dx); x = origin.x + origin.w - w; }
  if (handle.includes("n")) { h = Math.max(MIN_MM, origin.h - dy); y = origin.y + origin.h - h; }
  if (square) { const side = Math.max(w, h); w = side; h = side; }
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

export function Canvas({ document, scale, selectedId, onSelect, onDraft, onRelease }: {
  document: DesignDocument;
  scale: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDraft: (document: DesignDocument) => void;
  onRelease: () => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);

  const pointMm = (event: { clientX: number; clientY: number; }) => {
    const rect = surface.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  };
  const update = (id: string, patch: Partial<DesignElement>) => onDraft({ ...document, elements: document.elements.map((element) => (element.id === id ? ({ ...element, ...patch } as DesignElement) : element)) });

  function begin(event: ReactPointerEvent, next: Gesture) {
    event.stopPropagation();
    event.preventDefault();
    surface.current?.setPointerCapture(event.pointerId);
    setGesture(next);
  }

  function onPointerMove(event: ReactPointerEvent) {
    if (!gesture) return;
    const point = pointMm(event);
    if (gesture.kind === "move") {
      const moved = { ...gesture.origin, x: gesture.origin.x + point.x - gesture.start.x, y: gesture.origin.y + point.y - gesture.start.y };
      const snapped = event.altKey ? { box: { ...moved, x: round(moved.x), y: round(moved.y) }, guides: [] } : snapBox(moved, snapTargets(document, gesture.id), 1.5);
      setGuides(snapped.guides);
      update(gesture.id, { x: snapped.box.x, y: snapped.box.y });
    } else if (gesture.kind === "resize") {
      const element = document.elements.find((candidate) => candidate.id === gesture.id);
      update(gesture.id, resized(gesture.origin, gesture.handle, point.x - gesture.start.x, point.y - gesture.start.y, element?.kind === "qr" || (event.shiftKey && element?.kind !== "line")));
    } else {
      let angle = (Math.atan2(point.y - gesture.centre.y, point.x - gesture.centre.x) * 180) / Math.PI + 90;
      angle = ((Math.round(angle) % 360) + 360) % 360;
      const step = Math.round(angle / 15) * 15;
      if (event.shiftKey || Math.abs(angle - step) <= 3) angle = step % 360;
      update(gesture.id, { rotation: angle > 180 ? angle - 360 : angle });
    }
  }

  function end() {
    if (!gesture) return;
    setGesture(null);
    setGuides([]);
    onRelease();
  }

  const selected = document.elements.find((element) => element.id === selectedId) ?? null;
  return (
    <div
      ref={surface}
      role="application"
      aria-label="Ticket canvas. Select an element, then drag it, or use the arrow keys to nudge it."
      className="relative shrink-0 touch-none select-none shadow-none outline outline-1 outline-line"
      style={{ width: document.widthMm * scale, height: document.heightMm * scale, background: document.background }}
      onPointerDown={() => onSelect(null)}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {document.elements.map((element) => (element.hidden ? null : (
        <div
          key={element.id}
          style={boxStyle(element, scale)}
          className={cn(element.locked ? "cursor-default" : "cursor-move")}
          onPointerDown={(event) => {
            onSelect(element.id);
            if (!element.locked) begin(event, { kind: "move", id: element.id, start: pointMm(event), origin: { x: element.x, y: element.y, w: element.w, h: element.h } });
            else event.stopPropagation();
          }}
        >
          <ElementView element={element} scale={scale} />
        </div>
      )))}
      {selected && !selected.hidden ? (
        <div style={{ ...boxStyle(selected, scale), opacity: 1 }} className="pointer-events-none outline outline-2 outline-primary">
          {selected.locked ? null : (
            <>
              {(selected.kind === "line" ? (["e", "w"] as Handle[]) : HANDLES).map((handle) => (
                <span
                  key={handle}
                  aria-hidden
                  className={cn("pointer-events-auto absolute size-3 rounded-sm border border-primary bg-panel", HANDLE_POSITION[handle])}
                  onPointerDown={(event) => begin(event, { kind: "resize", id: selected.id, handle, start: pointMm(event), origin: { x: selected.x, y: selected.y, w: selected.w, h: selected.h } })}
                />
              ))}
              {selected.kind === "qr" ? null : (
                <span
                  aria-hidden
                  className="pointer-events-auto absolute -top-7 left-1/2 size-3.5 -translate-x-1/2 cursor-grab rounded-full border border-primary bg-panel"
                  onPointerDown={(event) => begin(event, { kind: "rotate", id: selected.id, centre: { x: selected.x + selected.w / 2, y: selected.y + selected.h / 2 } })}
                />
              )}
            </>
          )}
        </div>
      ) : null}
      {guides.map((guide) => (
        <div
          key={`${guide.axis}-${guide.at}`}
          aria-hidden
          className="pointer-events-none absolute bg-highlight"
          style={guide.axis === "x" ? { left: guide.at * scale, top: 0, width: 1, height: "100%" } : { top: guide.at * scale, left: 0, height: 1, width: "100%" }}
        />
      ))}
    </div>
  );
}
