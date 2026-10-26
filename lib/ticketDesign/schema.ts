import { z } from "zod";

/**
 * The ticket design document (docs/TICKET_DESIGNER.md), shared by the browser
 * editor and the server renderer. Every length is in millimetres from the
 * canvas's top-left corner; rotation is clockwise degrees about the element's
 * centre. The server validates the whole document on every save.
 */

export const DESIGN_VERSION = 1;
export const MAX_ELEMENTS = 60;
export const MIN_QR_MM = 18;
export const CANVAS_LIMITS = { min: 40, max: 300 } as const;

export const TICKET_FONTS = ["gilroy", "unbounded", "dejavu-sans", "dejavu-serif"] as const;
export type TicketFont = (typeof TICKET_FONTS)[number];
export const FONT_LABELS: Record<TicketFont, string> = { gilroy: "Gilroy", unbounded: "Unbounded", "dejavu-sans": "DejaVu Sans", "dejavu-serif": "DejaVu Serif" };
/** Weights each family offers: what the server renderer has outlines for (Unbounded at its default weight). */
export const FONT_WEIGHTS: Record<TicketFont, readonly number[]> = { gilroy: [400, 500, 600, 700], unbounded: [400], "dejavu-sans": [400, 700], "dejavu-serif": [400, 700] };

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #1A2B3C.");
const mm = z.number().finite().min(-300).max(600);
const size = z.number().finite().min(0.5).max(600);

const base = {
  id: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  x: mm,
  y: mm,
  w: size,
  h: size,
  rotation: z.number().finite().min(-360).max(360).default(0),
  opacity: z.number().finite().min(0).max(1).default(1),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  name: z.string().max(60).optional(),
};

export const textElementSchema = z.object({
  ...base,
  kind: z.literal("text"),
  /** May contain merge fields such as {{name}} (lib/ticketDesign/fields.ts). */
  text: z.string().max(500),
  font: z.enum(TICKET_FONTS),
  weight: z.number().int().min(100).max(900),
  sizePt: z.number().finite().min(4).max(200),
  color: hex,
  align: z.enum(["left", "center", "right"]),
  lineHeight: z.number().finite().min(0.8).max(3).default(1.2),
  letterSpacing: z.number().finite().min(-0.2).max(1).default(0),
  uppercase: z.boolean().optional(),
}).strict();

export const imageElementSchema = z.object({
  ...base,
  kind: z.literal("image"),
  /** An application-managed upload URL (checked against the organisation on save). */
  url: z.string().min(1).max(2048),
  fit: z.enum(["contain", "cover"]),
  radiusMm: z.number().finite().min(0).max(150).default(0),
}).strict();

export const shapeElementSchema = z.object({
  ...base,
  kind: z.enum(["rect", "ellipse"]),
  fill: hex.nullable(),
  stroke: hex.nullable(),
  strokeWidthMm: z.number().finite().min(0).max(20).default(0.5),
  radiusMm: z.number().finite().min(0).max(150).default(0),
}).strict();

/** A straight line across the element's width, through its vertical centre. */
export const lineElementSchema = z.object({
  ...base,
  kind: z.literal("line"),
  color: hex,
  strokeWidthMm: z.number().finite().min(0.1).max(20),
  dashed: z.boolean().optional(),
}).strict();

/** The check-in QR code: always drawn black on a white plate, never rotated or faded. */
export const qrElementSchema = z.object({ ...base, kind: z.literal("qr") }).strict();

export const designElementSchema = z.discriminatedUnion("kind", [textElementSchema, imageElementSchema, shapeElementSchema, lineElementSchema, qrElementSchema]);

export const designDocumentSchema = z.object({
  version: z.literal(DESIGN_VERSION),
  widthMm: z.number().finite().min(CANVAS_LIMITS.min).max(CANVAS_LIMITS.max),
  heightMm: z.number().finite().min(CANVAS_LIMITS.min).max(CANVAS_LIMITS.max),
  background: hex,
  elements: z.array(designElementSchema).max(MAX_ELEMENTS),
}).strict().superRefine((doc, ctx) => {
  const qrs = doc.elements.filter((element) => element.kind === "qr");
  if (qrs.length !== 1) {
    ctx.addIssue({ code: "custom", message: "A ticket needs exactly one check-in QR code.", path: ["elements"] });
    return;
  }
  const qr = qrs[0]!;
  const side = Math.min(qr.w, qr.h);
  if (side < MIN_QR_MM) ctx.addIssue({ code: "custom", message: `Make the QR code at least ${MIN_QR_MM} mm so it scans.`, path: ["elements"] });
  if (qr.hidden || qr.rotation % 360 !== 0 || qr.opacity < 1) ctx.addIssue({ code: "custom", message: "The QR code must stay visible, upright and solid so it scans.", path: ["elements"] });
  if (qr.x < 0 || qr.y < 0 || qr.x + side > doc.widthMm || qr.y + side > doc.heightMm) ctx.addIssue({ code: "custom", message: "Keep the whole QR code on the ticket.", path: ["elements"] });
  const ids = new Set<string>();
  for (const element of doc.elements) {
    if (ids.has(element.id)) ctx.addIssue({ code: "custom", message: "Two elements share an id.", path: ["elements"] });
    ids.add(element.id);
  }
});

export type DesignDocument = z.infer<typeof designDocumentSchema>;
export type DesignElement = z.infer<typeof designElementSchema>;
export type TextElement = z.infer<typeof textElementSchema>;
export type ImageElement = z.infer<typeof imageElementSchema>;
export type ShapeElement = z.infer<typeof shapeElementSchema>;
export type LineElement = z.infer<typeof lineElementSchema>;

/** The first problem with a document, phrased for the editor, or null. */
export function designProblem(document: unknown): string | null {
  const parsed = designDocumentSchema.safeParse(document);
  return parsed.success ? null : parsed.error.issues[0]?.message ?? "This design can't be saved.";
}
