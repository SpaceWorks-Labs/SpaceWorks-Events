import "server-only";

import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { managedImageKey } from "@/lib/badge/imageUrl";
import { qrModules, roundedRectPath } from "@/lib/badge/assets";
import { mmToPt, pixelSize, PNG_DPI } from "@/lib/badge/sheet";
import { downloadFile } from "@/lib/storage";
import { fillMergeFields, type MergeValues } from "./fields";
import type { DesignDocument, DesignElement, ImageElement } from "./schema";
import { textSvg } from "./text";

/*
 * Rendering a ticket design (docs/TICKET_DESIGNER.md): the document becomes
 * an SVG in millimetres (text as glyph outlines, images from managed uploads
 * only, the QR as vector modules on a white plate), rasterised by sharp. The
 * PDF holds that 300 dpi image at the ticket's exact size.
 */

const n = (value: number) => Number(value.toFixed(3));
const attr = (value: string) => value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
/** The QR's quiet zone, as a share of its plate. */
const QR_MARGIN = 0.08;

/** One managed image fitted to its box, as a data URL (null when it can't be read). */
async function imageHref(element: ImageElement, dpi: number) {
  const key = managedImageKey(element.url);
  if (!key) return null;
  try {
    const file = await downloadFile(key);
    if (!file) return null;
    const { width, height } = pixelSize(element.w, element.h, Math.min(dpi, 300));
    const data = await sharp(Buffer.from(file.body), { failOn: "error", limitInputPixels: 40_000_000 })
      .rotate()
      .resize(Math.min(width, 3000), Math.min(height, 3000), { fit: element.fit === "cover" ? "cover" : "inside", withoutEnlargement: false })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return { href: `data:image/png;base64,${data.data.toString("base64")}`, widthPx: data.info.width, heightPx: data.info.height };
  } catch {
    // A missing or undecodable image is left off the ticket rather than failing it.
    return null;
  }
}

async function elementSvg(element: DesignElement, values: MergeValues, qrValue: string, dpi: number, clipIndex: number) {
  if (element.kind === "text") return textSvg(element, fillMergeFields(element.text, values));
  if (element.kind === "rect" || element.kind === "ellipse") {
    const half = element.stroke ? element.strokeWidthMm / 2 : 0;
    const paint = `fill="${element.fill ?? "none"}"${element.stroke ? ` stroke="${element.stroke}" stroke-width="${n(element.strokeWidthMm)}"` : ""}`;
    if (element.kind === "ellipse") return `<ellipse cx="${n(element.x + element.w / 2)}" cy="${n(element.y + element.h / 2)}" rx="${n(element.w / 2 - half)}" ry="${n(element.h / 2 - half)}" ${paint}/>`;
    return `<path d="${roundedRectPath(element.x + half, element.y + half, element.w - 2 * half, element.h - 2 * half, Math.max(0, element.radiusMm - half))}" ${paint}/>`;
  }
  if (element.kind === "line") {
    const y = n(element.y + element.h / 2);
    const dash = element.dashed ? ` stroke-dasharray="${n(element.strokeWidthMm * 3)} ${n(element.strokeWidthMm * 2)}"` : "";
    return `<line x1="${n(element.x)}" y1="${y}" x2="${n(element.x + element.w)}" y2="${y}" stroke="${element.color}" stroke-width="${n(element.strokeWidthMm)}"${dash}/>`;
  }
  if (element.kind === "image") {
    const image = await imageHref(element, dpi);
    if (!image) return "";
    let box = { x: element.x, y: element.y, w: element.w, h: element.h };
    if (element.fit === "contain") {
      const scale = Math.min(element.w / image.widthPx, element.h / image.heightPx);
      const w = image.widthPx * scale;
      const h = image.heightPx * scale;
      box = { x: element.x + (element.w - w) / 2, y: element.y + (element.h - h) / 2, w, h };
    }
    const clip = element.radiusMm > 0 ? `<clipPath id="i${clipIndex}"><path d="${roundedRectPath(box.x, box.y, box.w, box.h, element.radiusMm)}"/></clipPath>` : "";
    return `${clip}<image${clip ? ` clip-path="url(#i${clipIndex})"` : ""} x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" preserveAspectRatio="none" href="${attr(image.href)}"/>`;
  }
  // The check-in QR: black modules on a white plate with a quiet zone, always square.
  const side = Math.min(element.w, element.h);
  const inner = side * (1 - 2 * QR_MARGIN);
  const qr = qrModules(qrValue);
  return `<rect x="${n(element.x)}" y="${n(element.y)}" width="${n(side)}" height="${n(side)}" fill="#FFFFFF"/><path transform="translate(${n(element.x + side * QR_MARGIN)} ${n(element.y + side * QR_MARGIN)}) scale(${(inner / qr.size).toPrecision(6)})" d="${qr.d}" fill="#000000" shape-rendering="crispEdges"/>`;
}

/** The design for one ticket as an SVG (millimetre user units) and its pixel size at `dpi`. */
export async function renderDesignSvg(document: DesignDocument, values: MergeValues, qrValue: string, dpi = PNG_DPI) {
  const { width, height } = pixelSize(document.widthMm, document.heightMm, dpi);
  const parts = [`<rect width="${document.widthMm}" height="${document.heightMm}" fill="${document.background}"/>`];
  for (const [index, element] of document.elements.entries()) {
    if (element.hidden) continue;
    const body = await elementSvg(element, values, qrValue, dpi, index);
    if (!body) continue;
    const rotate = element.kind !== "qr" && element.rotation % 360 !== 0 ? ` transform="rotate(${n(element.rotation)} ${n(element.x + element.w / 2)} ${n(element.y + element.h / 2)})"` : "";
    const opacity = element.kind !== "qr" && element.opacity < 1 ? ` opacity="${n(element.opacity)}"` : "";
    parts.push(rotate || opacity ? `<g${rotate}${opacity}>${body}</g>` : body);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${document.widthMm} ${document.heightMm}">${parts.join("")}</svg>`;
  return { svg, width, height };
}

/** One ticket as a PNG (300 dpi, or less for previews). */
export async function renderDesignPng(document: DesignDocument, values: MergeValues, qrValue: string, dpi = PNG_DPI) {
  const { svg, width, height } = await renderDesignSvg(document, values, qrValue, dpi);
  return sharp(Buffer.from(svg), { limitInputPixels: false }).resize(width, height).flatten({ background: document.background }).png({ compressionLevel: 9 }).withMetadata({ density: dpi }).toBuffer();
}

/** One ticket as a single-page PDF at its exact size. */
export async function renderDesignPdf(document: DesignDocument, values: MergeValues, qrValue: string, title: string) {
  const png = await renderDesignPng(document, values, qrValue);
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator("Space Works Events");
  pdf.setProducer("Space Works Events");
  const page = pdf.addPage([mmToPt(document.widthMm), mmToPt(document.heightMm)]);
  const image = await pdf.embedPng(png);
  page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  return pdf.save();
}
