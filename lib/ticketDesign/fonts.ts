import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit, { type Font } from "@pdf-lib/fontkit";
import { woffToSfnt } from "@/lib/badge/fonts";
import { FONT_WEIGHTS, type TicketFont } from "./schema";

/*
 * Fonts for rendering ticket designs (docs/TICKET_DESIGNER.md): Gilroy and
 * Unbounded from the brand fonts, DejaVu Sans and Serif (public/fonts/dejavu)
 * for wide script coverage. The browser editor loads the same files, so the
 * editor and the rendered ticket agree. Text becomes glyph outlines, so no
 * system fonts are involved.
 */

const PUBLIC = path.join(process.cwd(), "public");
const FILES: Record<TicketFont, Record<number, string>> = {
  gilroy: { 400: "brand/fonts/Gilroy-Regular.woff", 500: "brand/fonts/Gilroy-Medium.woff", 600: "brand/fonts/Gilroy-SemiBold.woff", 700: "brand/fonts/Gilroy-Bold.woff" },
  unbounded: { 400: "brand/fonts/Unbounded-Variable.woff2" },
  "dejavu-sans": { 400: "fonts/dejavu/DejaVuSans.ttf", 700: "fonts/dejavu/DejaVuSans-Bold.ttf" },
  "dejavu-serif": { 400: "fonts/dejavu/DejaVuSerif.ttf", 700: "fonts/dejavu/DejaVuSerif-Bold.ttf" },
};

const cache = new Map<string, Promise<Font>>();

/** The closest weight a family has. */
export function nearestWeight(font: TicketFont, weight: number) {
  return FONT_WEIGHTS[font].reduce((best, candidate) => (Math.abs(candidate - weight) < Math.abs(best - weight) ? candidate : best));
}

/** One face, read once per process. */
export function loadFace(font: TicketFont, weight: number): Promise<Font> {
  const chosen = nearestWeight(font, weight);
  const file = FILES[font][chosen]!;
  let entry = cache.get(file);
  if (!entry) {
    entry = readFile(path.join(PUBLIC, file)).then((bytes) => fontkit.create(Buffer.from(file.endsWith(".woff") ? woffToSfnt(new Uint8Array(bytes)) : bytes)) as Font);
    entry.catch(() => cache.delete(file));
    cache.set(file, entry);
  }
  return entry;
}

/** DejaVu Sans of the same weight: drawn for characters the chosen face lacks. */
export function fallbackFace(weight: number) {
  return loadFace("dejavu-sans", weight >= 600 ? 700 : 400);
}
