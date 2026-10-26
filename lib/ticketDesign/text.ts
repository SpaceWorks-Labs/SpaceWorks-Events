import "server-only";

import type { Font, Glyph } from "@pdf-lib/fontkit";
import { PT_TO_MM } from "@/lib/idCardPrint";
import { fallbackFace, loadFace } from "./fonts";
import type { TextElement } from "./schema";

/**
 * Text boxes on a ticket design: wrapped to the box width with the real glyph
 * metrics, aligned, and turned into SVG glyph outlines. Lines that don't fit
 * the box's height are left off (the first line always shows). Characters
 * the chosen face lacks are drawn in DejaVu Sans.
 */

type Placed = { glyph: Glyph; scale: number; };
const n = (value: number) => Number(value.toFixed(3));

async function shape(text: string, face: Font, fallback: Font, sizeMm: number) {
  const out: Placed[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const source = face.hasGlyphForCodePoint(code) || !fallback.hasGlyphForCodePoint(code) ? face : fallback;
    out.push({ glyph: source.glyphForCodePoint(code), scale: sizeMm / source.unitsPerEm });
  }
  return out;
}

function width(glyphs: Placed[], tracking: number) {
  return glyphs.reduce((sum, placed) => sum + placed.glyph.advanceWidth * placed.scale + tracking, 0) - (glyphs.length ? tracking : 0);
}

/** Greedy word wrap; a word longer than the line breaks by character. */
async function wrap(text: string, face: Font, fallback: Font, sizeMm: number, tracking: number, maxWidth: number) {
  const lines: Placed[][] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    const words = paragraph.split(/(\s+)/).filter((part) => part.length > 0);
    for (const word of words) {
      const candidate = line + word;
      if (!line.trim() || width(await shape(candidate.trimEnd(), face, fallback, sizeMm), tracking) <= maxWidth) {
        line = candidate.trimStart();
      } else {
        lines.push(await shape(line.trimEnd(), face, fallback, sizeMm));
        line = word.trimStart();
      }
      // A word wider than the box is split by character, wherever it starts.
      while (line && width(await shape(line.trimEnd(), face, fallback, sizeMm), tracking) > maxWidth && [...line.trimEnd()].length > 1) {
        const chars = [...line];
        let cut = chars.length - 1;
        while (cut > 1 && width(await shape(chars.slice(0, cut).join(""), face, fallback, sizeMm), tracking) > maxWidth) cut -= 1;
        lines.push(await shape(chars.slice(0, cut).join(""), face, fallback, sizeMm));
        line = chars.slice(cut).join("");
      }
    }
    lines.push(await shape(line.trimEnd(), face, fallback, sizeMm));
  }
  return lines;
}

/** The SVG for one text element's content (already merged), in the element's own box. */
export async function textSvg(element: TextElement, content: string) {
  const face = await loadFace(element.font, element.weight);
  const fallback = await fallbackFace(element.weight);
  const sizeMm = element.sizePt * PT_TO_MM;
  const tracking = element.letterSpacing * sizeMm;
  const text = element.uppercase ? content.toLocaleUpperCase("en") : content;
  const lineMm = sizeMm * element.lineHeight;
  const ascent = (face.ascent / face.unitsPerEm) * sizeMm;
  const lines = await wrap(text, face, fallback, sizeMm, tracking, element.w);
  let out = "";
  for (const [index, line] of lines.entries()) {
    const top = index * lineMm;
    if (index > 0 && top + lineMm > element.h + 0.01) break;
    const lineWidth = width(line, tracking);
    let cursor = element.x + (element.align === "center" ? (element.w - lineWidth) / 2 : element.align === "right" ? element.w - lineWidth : 0);
    const baseline = element.y + top + (lineMm - sizeMm) / 2 + ascent;
    for (const placed of line) {
      const d = placed.glyph.path.toSVG();
      if (d) out += `<path transform="translate(${n(cursor)} ${n(baseline)}) scale(${placed.scale.toPrecision(6)} ${(-placed.scale).toPrecision(6)})" d="${d}"/>`;
      cursor += placed.glyph.advanceWidth * placed.scale + tracking;
    }
  }
  return out ? `<g fill="${element.color}">${out}</g>` : "";
}
