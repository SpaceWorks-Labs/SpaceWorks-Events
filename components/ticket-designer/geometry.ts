import type { DesignDocument, DesignElement } from "@/lib/ticketDesign/schema";

/**
 * Pure helpers for the ticket designer (docs/TICKET_DESIGNER.md): snapping,
 * alignment and new elements. Lengths are millimetres.
 */

export type Guide = { axis: "x" | "y"; at: number; };
export type Box = { x: number; y: number; w: number; h: number; };

/** How close (mm) an edge or centre must come to a target to snap to it. */
export const SNAP_MM = 1.5;

const round = (value: number) => Math.round(value * 10) / 10;

/** Edges and centres of the canvas and the other visible elements, per axis. */
export function snapTargets(document: DesignDocument, movingId: string) {
  const xs = [0, document.widthMm / 2, document.widthMm];
  const ys = [0, document.heightMm / 2, document.heightMm];
  for (const element of document.elements) {
    if (element.id === movingId || element.hidden) continue;
    xs.push(element.x, element.x + element.w / 2, element.x + element.w);
    ys.push(element.y, element.y + element.h / 2, element.y + element.h);
  }
  return { xs, ys };
}

function snapAxis(start: number, size: number, targets: number[], threshold: number) {
  let best: { delta: number; at: number; } | null = null;
  for (const edge of [start, start + size / 2, start + size]) {
    for (const target of targets) {
      const delta = target - edge;
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at: target };
    }
  }
  return best;
}

/** A moved box, pulled onto the nearest edge or centre within the threshold, and the guides to draw. */
export function snapBox(box: Box, targets: { xs: number[]; ys: number[]; }, threshold = SNAP_MM): { box: Box; guides: Guide[]; } {
  const x = snapAxis(box.x, box.w, targets.xs, threshold);
  const y = snapAxis(box.y, box.h, targets.ys, threshold);
  const guides: Guide[] = [];
  if (x) guides.push({ axis: "x", at: x.at });
  if (y) guides.push({ axis: "y", at: y.at });
  return { box: { ...box, x: round(box.x + (x?.delta ?? 0)), y: round(box.y + (y?.delta ?? 0)) }, guides };
}

export type Alignment = "left" | "center" | "right" | "top" | "middle" | "bottom";

/** The element's new position when aligned to the canvas. */
export function alignToCanvas(element: Box, document: Pick<DesignDocument, "widthMm" | "heightMm">, alignment: Alignment): Pick<Box, "x" | "y"> {
  switch (alignment) {
    case "left": return { x: 0, y: element.y };
    case "center": return { x: round((document.widthMm - element.w) / 2), y: element.y };
    case "right": return { x: round(document.widthMm - element.w), y: element.y };
    case "top": return { x: element.x, y: 0 };
    case "middle": return { x: element.x, y: round((document.heightMm - element.h) / 2) };
    case "bottom": return { x: element.x, y: round(document.heightMm - element.h) };
  }
}

/** A short unique id for a new element. */
export function newElementId(document: DesignDocument, prefix: string) {
  const taken = new Set(document.elements.map((element) => element.id));
  for (let index = 1; ; index += 1) {
    const candidate = `${prefix}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A new element of each kind, placed near the canvas centre. */
export function newElement(document: DesignDocument, kind: "text" | "field" | "rect" | "ellipse" | "line" | "image", extra: { url?: string; field?: string; } = {}): DesignElement {
  const centre = { x: document.widthMm / 2, y: document.heightMm / 2 };
  const base = { rotation: 0, opacity: 1 };
  if (kind === "text" || kind === "field") {
    const w = Math.min(80, document.widthMm - 10);
    return { ...base, id: newElementId(document, "text"), kind: "text", text: kind === "field" ? `{{${extra.field ?? "name"}}}` : "Your text", x: round(centre.x - w / 2), y: round(centre.y - 5), w, h: 10, font: "gilroy", weight: 600, sizePt: 14, color: "#1A1A1A", align: "left", lineHeight: 1.2, letterSpacing: 0 };
  }
  if (kind === "line") return { ...base, id: newElementId(document, "line"), kind: "line", x: round(centre.x - 30), y: round(centre.y - 0.5), w: 60, h: 1, color: "#1A1A1A", strokeWidthMm: 0.5 };
  if (kind === "image") return { ...base, id: newElementId(document, "image"), kind: "image", url: extra.url ?? "", x: round(centre.x - 20), y: round(centre.y - 15), w: 40, h: 30, fit: "contain", radiusMm: 0 };
  return { ...base, id: newElementId(document, kind), kind, x: round(centre.x - 20), y: round(centre.y - 10), w: 40, h: 20, fill: "#E8F3F1", stroke: null, strokeWidthMm: 0.5, radiusMm: kind === "rect" ? 2 : 0 };
}

/** A copy of an element, nudged so it doesn't sit exactly on the original. */
export function duplicateElement(document: DesignDocument, element: DesignElement): DesignElement {
  return { ...element, id: newElementId(document, element.kind === "qr" ? "copy" : element.kind), x: round(element.x + 3), y: round(element.y + 3), locked: false };
}

/** A readable layer name. */
export function layerName(element: DesignElement) {
  if (element.name) return element.name;
  if (element.kind === "text") return element.text.trim().slice(0, 28) || "Text";
  return { image: "Image", rect: "Rectangle", ellipse: "Ellipse", line: "Line", qr: "Check-in QR code" }[element.kind];
}
