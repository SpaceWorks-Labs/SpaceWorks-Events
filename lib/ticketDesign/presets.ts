import { DESIGN_VERSION, type DesignDocument } from "./schema";

/**
 * Canvas sizes and starter designs (docs/TICKET_DESIGNER.md). "Classic" is
 * also the built-in design every ticket uses until its organisation, event or
 * ticket type picks another.
 */

export const CANVAS_PRESETS = [
  { key: "ticket", label: "Ticket stub · 180 × 70 mm", widthMm: 180, heightMm: 70 },
  { key: "wide", label: "Wide ticket · 200 × 80 mm", widthMm: 200, heightMm: 80 },
  { key: "a6", label: "A6 landscape · 148 × 105 mm", widthMm: 148, heightMm: 105 },
  { key: "a6-portrait", label: "A6 portrait · 105 × 148 mm", widthMm: 105, heightMm: 148 },
  { key: "phone", label: "Phone screen · 90 × 160 mm", widthMm: 90, heightMm: 160 },
  { key: "badge", label: "Badge · 4 × 6 in", widthMm: 101.6, heightMm: 152.4 },
] as const;

const text = (id: string, text: string, x: number, y: number, w: number, h: number, sizePt: number, extra: Partial<{ weight: number; color: string; font: "gilroy" | "unbounded" | "dejavu-sans" | "dejavu-serif"; align: "left" | "center" | "right"; uppercase: boolean; letterSpacing: number }> = {}) => ({
  id, kind: "text" as const, text, x, y, w, h, rotation: 0, opacity: 1, font: extra.font ?? "gilroy", weight: extra.weight ?? 400, sizePt,
  color: extra.color ?? "#1A1A1A", align: extra.align ?? "left", lineHeight: 1.15, letterSpacing: extra.letterSpacing ?? 0, ...(extra.uppercase ? { uppercase: true } : {}),
});

/** A clean stub: event, attendee, details on the left, the QR on a tinted right panel. */
export const CLASSIC_DESIGN: DesignDocument = {
  version: DESIGN_VERSION,
  widthMm: 180,
  heightMm: 70,
  background: "#FFFFFF",
  elements: [
    { id: "panel", kind: "rect", x: 128, y: 0, w: 52, h: 70, rotation: 0, opacity: 1, fill: "#E8F3F1", stroke: null, strokeWidthMm: 0.5, radiusMm: 0 },
    // Rotated about its centre (128, 35): a vertical tear line down the panel's edge.
    { id: "rule", kind: "line", x: 93, y: 34.5, w: 70, h: 1, rotation: 90, opacity: 1, color: "#9DBDB7", strokeWidthMm: 0.4, dashed: true },
    text("org", "{{organisation}}", 10, 8, 110, 6, 9, { weight: 600, color: "#4A5B58", uppercase: true, letterSpacing: 0.08 }),
    text("title", "{{event}}", 10, 15, 112, 18, 18, { weight: 700 }),
    text("name", "{{name}}", 10, 36, 112, 9, 13, { weight: 600 }),
    text("when", "{{date}} · {{time}}", 10, 47, 112, 6, 9, { color: "#3A3A3A" }),
    text("where", "{{venue}}", 10, 53, 112, 6, 9, { color: "#3A3A3A" }),
    text("ticket", "{{ticket}} · {{registration}}", 10, 60, 112, 5, 7.5, { color: "#6A6A6A" }),
    { id: "qr", kind: "qr", x: 133, y: 14, w: 42, h: 42, rotation: 0, opacity: 1 },
  ],
};

/** A bold dark pass with a display title. */
const NIGHT_DESIGN: DesignDocument = {
  version: DESIGN_VERSION,
  widthMm: 180,
  heightMm: 70,
  background: "#14211F",
  elements: [
    { id: "band", kind: "rect", x: 0, y: 0, w: 6, h: 70, rotation: 0, opacity: 1, fill: "#F59E42", stroke: null, strokeWidthMm: 0.5, radiusMm: 0 },
    text("title", "{{event}}", 14, 9, 108, 22, 17, { font: "unbounded", color: "#FFFFFF" }),
    text("name", "{{name}}", 14, 36, 108, 9, 13, { weight: 700, color: "#FFFFFF" }),
    text("details", "{{date}} · {{time}} · {{venue}}", 14, 48, 108, 12, 8.5, { color: "#C9D6D3" }),
    { id: "plate", kind: "rect", x: 128, y: 9, w: 46, h: 52, rotation: 0, opacity: 1, fill: "#FFFFFF", stroke: null, strokeWidthMm: 0.5, radiusMm: 3 },
    { id: "qr", kind: "qr", x: 131, y: 12, w: 40, h: 40, rotation: 0, opacity: 1 },
    text("ticket", "{{ticket}}", 129, 53, 44, 6, 7, { align: "center", color: "#14211F", weight: 600 }),
  ],
};

/** A portrait card for phones and lanyards. */
const PORTRAIT_DESIGN: DesignDocument = {
  version: DESIGN_VERSION,
  widthMm: 105,
  heightMm: 148,
  background: "#FFFFFF",
  elements: [
    { id: "header", kind: "rect", x: 0, y: 0, w: 105, h: 42, rotation: 0, opacity: 1, fill: "#0F766E", stroke: null, strokeWidthMm: 0.5, radiusMm: 0 },
    text("org", "{{organisation}}", 9, 8, 87, 6, 9, { color: "#D9F2EE", uppercase: true, letterSpacing: 0.08, weight: 600 }),
    text("title", "{{event}}", 9, 16, 87, 22, 17, { weight: 700, color: "#FFFFFF" }),
    text("name", "{{name}}", 9, 48, 87, 10, 15, { weight: 700, align: "center" }),
    text("ticket", "{{ticket}}", 9, 59, 87, 6, 9, { align: "center", color: "#4A5B58" }),
    { id: "qr", kind: "qr", x: 27.5, y: 70, w: 50, h: 50, rotation: 0, opacity: 1 },
    text("when", "{{date}} · {{time}}", 9, 126, 87, 6, 9, { align: "center" }),
    text("where", "{{venue}}", 9, 133, 87, 6, 9, { align: "center", color: "#3A3A3A" }),
  ],
};

export const STARTER_DESIGNS = [
  { key: "classic", label: "Classic stub", document: CLASSIC_DESIGN },
  { key: "night", label: "Night pass", document: NIGHT_DESIGN },
  { key: "portrait", label: "Portrait card", document: PORTRAIT_DESIGN },
] as const;
