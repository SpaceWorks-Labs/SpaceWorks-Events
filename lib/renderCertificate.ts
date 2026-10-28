import "server-only";
import sharp from "sharp";
import {
  certificateFonts,
  certificateTemplateKeys,
  certificateTemplateSchema,
  fillCertificateText,
  type CertificateImageElement,
  type CertificateMergeValues,
  type CertificateTemplate,
  type CertificateTextElement,
} from "./certificateTemplate";
import { formatDate } from "./format/datetime";
import { downloadFile } from "./storage";

const escapeMarkup = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/**
 * A font size that keeps one line of text inside `maxWidth`, estimated from
 * the character count (`emWidth` is the average glyph width in em). The
 * standard certificate is an SVG, which cannot shrink text to fit by itself.
 */
export function fittedFontSize(text: string, base: number, maxWidth: number, emWidth: number) {
  const estimated = Array.from(text).length * emWidth * base;
  return estimated <= maxWidth ? base : Math.max(12, Math.floor(maxWidth / (Array.from(text).length * emWidth)));
}

/** The built-in certificate used when an organiser has not designed one. 1600 × 1130 px. */
export function standardCertificateSvg(input: { organisationName: string; attendee: string; eventTitle: string; issuedAt: Date }) {
  // The frame's inner width is 1530 px; keep every line well inside it.
  const line = 1380;
  const organisation = fittedFontSize(input.organisationName, 42, line, 0.6);
  const heading = fittedFontSize("CERTIFICATE OF PARTICIPATION", 72, line, 0.72);
  const name = fittedFontSize(input.attendee, 80, line, 0.62);
  const title = fittedFontSize(input.eventTitle, 62, line, 0.62);
  const issued = input.issuedAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1130" viewBox="0 0 1600 1130"><rect width="1600" height="1130" fill="#fff"/><rect x="35" y="35" width="1530" height="1060" rx="20" fill="none" stroke="#1d3557" stroke-width="8"/><text x="800" y="175" text-anchor="middle" font-family="'DejaVu Serif',serif" font-size="${organisation}" fill="#1d3557">${escapeMarkup(input.organisationName)}</text><text x="800" y="335" text-anchor="middle" font-family="'DejaVu Serif',serif" font-size="${heading}" font-weight="700" fill="#111827">CERTIFICATE OF PARTICIPATION</text><text x="800" y="455" text-anchor="middle" font-family="'DejaVu Sans',sans-serif" font-size="35" fill="#4b5563">This certifies that</text><text x="800" y="585" text-anchor="middle" font-family="'DejaVu Serif',serif" font-size="${name}" font-weight="700" fill="#111827">${escapeMarkup(input.attendee)}</text><line x1="360" y1="620" x2="1240" y2="620" stroke="#94a3b8" stroke-width="3"/><text x="800" y="715" text-anchor="middle" font-family="'DejaVu Sans',sans-serif" font-size="35" fill="#4b5563">has completed the feedback for</text><text x="800" y="805" text-anchor="middle" font-family="'DejaVu Serif',serif" font-size="${title}" font-weight="700" fill="#1d3557">${escapeMarkup(input.eventTitle)}</text><text x="800" y="945" text-anchor="middle" font-family="'DejaVu Sans',sans-serif" font-size="28" fill="#64748b">Issued ${issued}</text></svg>`;
}

/** Merge-tag values for one certificate; dates use the event's timezone. */
export function certificateMergeValues(input: { name: string; eventTitle: string; eventStart: Date; timeZone: string; organisationName: string; issuedAt: Date; role?: string; hours?: string }): CertificateMergeValues {
  return {
    name: input.name,
    event: input.eventTitle,
    eventDate: formatDate(input.eventStart, input.timeZone),
    organisation: input.organisationName,
    issueDate: formatDate(input.issuedAt, input.timeZone),
    role: input.role ?? "",
    hours: input.hours ?? "",
  };
}

type Box = { left: number; top: number; width: number; height: number };
type Layer = { input: Buffer; left: number; top: number };

function boxFor(element: { x: number; y: number; width: number; height: number }, width: number, height: number): Box {
  return {
    left: Math.floor(width * element.x / 100),
    top: Math.floor(height * element.y / 100),
    width: Math.max(1, Math.floor(width * element.width / 100)),
    height: Math.max(1, Math.floor(height * element.height / 100)),
  };
}

/** True when every key belongs to this organisation's certificate folders. */
export function certificateKeysBelongTo(template: CertificateTemplate, organisationId: string) {
  const { background, assets } = certificateTemplateKeys(template);
  return background.startsWith(`organisations/${organisationId}/certificate-backgrounds/`) && assets.every((key) => key.startsWith(`organisations/${organisationId}/certificate-assets/`));
}

async function textLayer(element: CertificateTextElement, values: CertificateMergeValues, width: number, height: number): Promise<Layer | null> {
  const filled = fillCertificateText(element.text, values).replace(/\t/g, " ").replace(/\r\n?/g, "\n").trim().slice(0, 600);
  if (!filled) return null;
  const text = element.uppercase ? filled.toLocaleUpperCase("en") : filled;
  const area = boxFor(element, width, height);
  const style = [element.bold ? "Bold" : "", element.italic ? "Italic" : ""].filter(Boolean).join(" ");
  // Measure first, then rasterize at the final font size: never shrink a bitmap
  // of the text, which blurs thin strokes and small glyphs.
  const render = (size: number) => {
    const spacing = Math.round(size * element.letterSpacing / 100 * 1024);
    return sharp({ text: {
      text: `<span foreground="${element.color}"${spacing ? ` letter_spacing="${spacing}"` : ""}>${escapeMarkup(text)}</span>`,
      font: `${certificateFonts[element.font].family}${style ? ` ${style}` : ""} ${size}`,
      width: area.width,
      wrap: "word",
      align: element.align === "center" ? "centre" : element.align,
      dpi: 72, rgba: true,
    } }).png().toBuffer({ resolveWithObject: true });
  };
  let size = Math.max(1, element.fontSize * width / 1000);
  let fitted = await render(size);
  for (let attempt = 0; attempt < 8 && (fitted.info.width > area.width || fitted.info.height > area.height); attempt++) {
    size *= Math.min(area.width / fitted.info.width, area.height / fitted.info.height) * 0.97;
    fitted = await render(Math.max(1, size));
  }
  if (fitted.info.width > area.width || fitted.info.height > area.height) throw new Error("Text area is too small.");
  const offset = element.align === "center" ? (area.width - fitted.info.width) / 2 : element.align === "right" ? area.width - fitted.info.width : 0;
  return { input: fitted.data, left: Math.floor(area.left + offset), top: Math.floor(area.top + (area.height - fitted.info.height) / 2) };
}

async function imageLayer(element: CertificateImageElement, body: Buffer, width: number, height: number): Promise<Layer> {
  const area = boxFor(element, width, height);
  const { data, info } = await sharp(body).ensureAlpha().resize(area.width, area.height, { fit: "inside" }).png().toBuffer({ resolveWithObject: true });
  return { input: data, left: Math.floor(area.left + (area.width - info.width) / 2), top: Math.floor(area.top + (area.height - info.height) / 2) };
}

export async function renderCustomCertificate(template: CertificateTemplate, values: CertificateMergeValues, organisationId: string) {
  const config = certificateTemplateSchema.parse(template);
  if (!certificateKeysBelongTo(config, organisationId)) throw new Error("Invalid certificate image.");
  const image = await downloadFile(config.backgroundKey);
  if (!image) throw new Error("Certificate background unavailable.");
  const source = await sharp(image.body).metadata();
  if (!source.width || !source.height) throw new Error("Invalid certificate dimensions.");

  const assetKeys = [...new Set(certificateTemplateKeys(config).assets)];
  const assets = new Map(await Promise.all(assetKeys.map(async (key) => {
    const file = await downloadFile(key);
    if (!file) throw new Error("Certificate image unavailable.");
    return [key, Buffer.from(file.body)] as const;
  })));

  // Give text a print-sized canvas even when older backgrounds were resized.
  // Upsampling cannot recover missing detail in an already compressed background.
  const scale = Math.max(1, 3508 / Math.max(source.width, source.height));
  const width = Math.round(source.width * scale);
  const height = Math.round(source.height * scale);
  const layers = (await Promise.all(config.elements.map((element) =>
    element.type === "text" ? textLayer(element, values, width, height) : imageLayer(element, assets.get(element.key)!, width, height),
  ))).filter((layer): layer is Layer => layer != null);

  // Flatten the background before compositing so transparent artwork prints on white.
  const base = await sharp(image.body).resize(width, height).flatten({ background: "#fff" }).png().toBuffer();
  return sharp(base).composite(layers).withMetadata({ density: 300 }).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
}
