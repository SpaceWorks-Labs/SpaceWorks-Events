import { z } from "zod";

export const certificateFonts = {
  serif: { label: "Classic serif", family: "DejaVu Serif", css: '"DejaVu Serif", Georgia, serif' },
  sans: { label: "Clean sans", family: "DejaVu Sans", css: '"DejaVu Sans", Arial, sans-serif' },
  mono: { label: "Monospace", family: "DejaVu Sans Mono", css: '"DejaVu Sans Mono", monospace' },
} as const;

/** Merge tags a text layer can use. Values are filled in when the certificate is downloaded. */
export const certificateMergeTags = {
  name: { label: "Attendee name", sample: "Alex Morgan" },
  event: { label: "Event title", sample: "Your event" },
  eventDate: { label: "Event date", sample: "14 Oct 2026" },
  organisation: { label: "Organisation", sample: "Your organisation" },
  issueDate: { label: "Issue date", sample: "15 Oct 2026" },
  /** Contributor certificates only (docs/VOLUNTEERS.md); empty on attendee certificates. */
  role: { label: "Contributor role", sample: "Volunteer · Registration desk" },
  hours: { label: "Hours contributed", sample: "6.5 hours" },
} as const;
export type CertificateMergeTag = keyof typeof certificateMergeTags;
export type CertificateMergeValues = Record<CertificateMergeTag, string>;
/** Tags only contributor certificates fill. */
export const CONTRIBUTOR_MERGE_TAGS: readonly CertificateMergeTag[] = ["role", "hours"];

const MERGE_TAG = /\{\{\s*(name|event|eventDate|organisation|issueDate|role|hours)\s*\}\}/g;

/** Replaces merge tags with plain values. The result is plain text, never markup. */
export function fillCertificateText(text: string, values: CertificateMergeValues): string {
  return text.replace(MERGE_TAG, (_, tag: CertificateMergeTag) => values[tag].replace(/[\r\n\t]+/g, " ").trim());
}

const BACKGROUND_KEY = /^organisations\/[A-Za-z0-9_-]{1,128}\/certificate-backgrounds\/[0-9a-f-]{36}\.webp$/;
const ASSET_KEY = /^organisations\/[A-Za-z0-9_-]{1,128}\/certificate-assets\/[0-9a-f-]{36}\.webp$/;

const box = {
  x: z.number().min(0).max(99),
  y: z.number().min(0).max(99),
  width: z.number().min(2).max(100),
  height: z.number().min(2).max(100),
};
const insideImage = (v: { x: number; y: number; width: number; height: number }) => v.x + v.width <= 100.001 && v.y + v.height <= 100.001;
const elementId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);

export const certificateTextElementSchema = z.object({
  id: elementId,
  type: z.literal("text"),
  /** Plain text with optional merge tags such as {{name}}. Line breaks are kept. */
  text: z.string().trim().min(1).max(300),
  ...box,
  font: z.enum(["serif", "sans", "mono"]),
  /** Relative to a 1000 px image width. */
  fontSize: z.number().int().min(6).max(160),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  bold: z.boolean(),
  italic: z.boolean(),
  uppercase: z.boolean(),
  /** Extra space between letters, in hundredths of the font size (0–50). */
  letterSpacing: z.number().int().min(0).max(50),
  align: z.enum(["left", "center", "right"]),
}).strict();

export const certificateImageElementSchema = z.object({
  id: elementId,
  type: z.literal("image"),
  /** A logo, signature or seal uploaded by the organisation. */
  key: z.string().max(300).regex(ASSET_KEY),
  /** Shown in the builder's layer list only. */
  label: z.string().trim().max(60),
  ...box,
}).strict();

export const certificateElementSchema = z.discriminatedUnion("type", [certificateTextElementSchema, certificateImageElementSchema]);

export const certificateTemplateSchema = z.object({
  version: z.literal(2),
  backgroundKey: z.string().max(300).regex(BACKGROUND_KEY),
  /** Painted in order: later layers sit on top. */
  elements: z.array(certificateElementSchema).max(20),
}).strict()
  .refine((v) => v.elements.every(insideImage), "Keep every layer inside the image.")
  .refine((v) => new Set(v.elements.map((element) => element.id)).size === v.elements.length, "Layer ids must be unique.");

export type CertificateTemplate = z.infer<typeof certificateTemplateSchema>;
export type CertificateElement = z.infer<typeof certificateElementSchema>;
export type CertificateTextElement = z.infer<typeof certificateTextElementSchema>;
export type CertificateImageElement = z.infer<typeof certificateImageElementSchema>;

/** The original single name-area layout, still found in saved forms and issued certificates. */
export const legacyCertificateTemplateSchema = z.object({
  backgroundKey: z.string().max(300).regex(BACKGROUND_KEY),
  x: z.number().min(0).max(99),
  y: z.number().min(0).max(99),
  width: z.number().min(5).max(100),
  height: z.number().min(3).max(100),
  font: z.enum(["serif", "sans", "mono"]),
  fontSize: z.number().int().min(12).max(120),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  bold: z.boolean(),
  align: z.enum(["left", "center", "right"]),
}).strict().refine((v) => v.x + v.width <= 100 && v.y + v.height <= 100, "Keep the name area inside the image.");

export const defaultNameArea = { x: 15, y: 43, width: 70, height: 14, font: "serif", fontSize: 48, color: "#16243a", bold: false, align: "center" } as const;

export function defaultNameElement(id = "name"): CertificateTextElement {
  return { id, type: "text", text: "{{name}}", ...defaultNameArea, italic: false, uppercase: false, letterSpacing: 0 };
}

export function upgradeLegacyTemplate(legacy: z.infer<typeof legacyCertificateTemplateSchema>): CertificateTemplate {
  const { backgroundKey, ...area } = legacy;
  return { version: 2, backgroundKey, elements: [{ id: "name", type: "text", text: "{{name}}", ...area, italic: false, uppercase: false, letterSpacing: 0 }] };
}

/** Accepts the current layout or the legacy single name area, always producing the current layout. */
export const certificateTemplateInputSchema = z.union([
  certificateTemplateSchema,
  legacyCertificateTemplateSchema.transform(upgradeLegacyTemplate),
]);

export function parseCertificateTemplate(value: unknown): CertificateTemplate | null {
  const parsed = certificateTemplateInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Every storage key a template points at, for tenant and asset checks. */
export function certificateTemplateKeys(template: CertificateTemplate): { background: string; assets: string[] } {
  return { background: template.backgroundKey, assets: template.elements.flatMap((element) => (element.type === "image" ? [element.key] : [])) };
}
