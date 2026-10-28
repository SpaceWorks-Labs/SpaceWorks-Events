import {
  certificateMergeTags,
  type CertificateElement,
  type CertificateMergeValues,
  type CertificateTemplate,
  type CertificateTextElement,
} from "@/lib/certificateTemplate";

export const MAX_LAYERS = 20;
/** Smallest layer box, as a percentage of the image (matches the template schema). */
export const MIN_BOX = 2;
/** Box centres within this distance (in %) of the image centre snap to it while dragging. */
export const SNAP_DISTANCE = 1;

export type Box = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Keeps a box at least MIN_BOX in size and entirely inside the image. */
export function clampBox(box: Box): Box {
  const width = round2(clamp(box.width, MIN_BOX, 100));
  const height = round2(clamp(box.height, MIN_BOX, 100));
  return {
    width,
    height,
    x: round2(clamp(box.x, 0, Math.min(99, 100 - width))),
    y: round2(clamp(box.y, 0, Math.min(99, 100 - height))),
  };
}

/** A short layer id that matches /^[A-Za-z0-9_-]{1,32}$/ and is not already used. */
export function newLayerId(prefix: "t" | "i", elements: CertificateElement[]): string {
  const base = `${prefix}${Date.now().toString(36)}`;
  const taken = new Set(elements.map((element) => element.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export function newTextElement(id: string): CertificateTextElement {
  return {
    id, type: "text", text: "Text",
    x: 35, y: 45, width: 30, height: 10,
    font: "sans", fontSize: 28, color: "#16243a",
    bold: false, italic: false, uppercase: false, letterSpacing: 0, align: "center",
  };
}

/**
 * A box for an image of the given natural size that keeps its aspect ratio on
 * a background of the given size, `width` % wide and centred on (cx, cy).
 */
export function imageBox(natural: Size, background: Size, width = 20, cx = 50, cy = 50): Box {
  const aspect = natural.width > 0 && natural.height > 0 ? natural.height / natural.width : 1;
  const ratio = background.width / background.height;
  let w = width;
  let h = w * aspect * ratio;
  // Keep tall images (signatures rotated, seals) from overflowing the page.
  const maxHeight = 60;
  if (h > maxHeight) { w = w * maxHeight / h; h = maxHeight; }
  return clampBox({ x: cx - w / 2, y: cy - h / 2, width: w, height: h });
}

export function layerName(element: CertificateElement): string {
  if (element.type === "image") return element.label.trim() || "Image";
  const flat = element.text.replace(/\s+/g, " ").trim();
  return flat || "Empty text";
}

export const usesNameTag = (template: CertificateTemplate) =>
  template.elements.some((element) => element.type === "text" && /\{\{\s*name\s*\}\}/.test(element.text));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Formats a date like "15 Oct 2026", the same style the downloaded certificate uses. */
export const formatIssueDate = (date: Date) => `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;

export function sampleValues(input: { name: string; eventTitle?: string; eventDateLabel?: string; organisationName?: string; issueDate: string }): CertificateMergeValues {
  return {
    name: input.name.trim() || certificateMergeTags.name.sample,
    event: input.eventTitle?.trim() || certificateMergeTags.event.sample,
    eventDate: input.eventDateLabel?.trim() || certificateMergeTags.eventDate.sample,
    organisation: input.organisationName?.trim() || certificateMergeTags.organisation.sample,
    issueDate: input.issueDate,
    role: certificateMergeTags.role.sample,
    hours: certificateMergeTags.hours.sample,
  };
}

/** Reads an image's natural size in the browser. */
export function loadImageSize(src: string): Promise<Size> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("Image could not load."));
    image.src = src;
  });
}

export const uploadUrl = (key: string) => `/api/uploads/${key}`;
