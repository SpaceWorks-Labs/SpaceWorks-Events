import {
  badgeLabelPt,
  watermarkSizePt,
  DETAILS_COLUMN_GAP_MM,
  DETAILS_ROW_GAP_MM,
  ID_CARD_LINE_HEIGHT,
  idCardTemplateDecor,
  nameSizePt,
  PT_TO_MM,
  sponsorStripHeightMm,
  TILE_PADDING_MM,
  type IdCardPrintSettings,
} from "@/lib/idCardPrint";
import { resolveBadgePalette, SYMBOL_ASPECT, type BadgePalette, type BadgeSymbolVariant } from "./palette";
import { attendeeInitials, printableFields, withMergeFields, type BadgeBranding, type IdCardAttendee } from "./types";

/*
 * Turns a design, an attendee and the event's artwork into a flat list of
 * drawing operations in millimetres (top-left origin). The PDF and PNG
 * renderers draw exactly these, so both outputs match. It mirrors the
 * browser preview (components/checkin/id-card/BadgeCanvas.tsx): same boxes,
 * line heights, template decor and palette.
 */

export type FontWeight = 400 | 600 | 700;

/** Text measurement in millimetres, backed by the embedded Gilroy faces. */
export type TextMeasurer = {
  widthMm(text: string, weight: FontWeight, sizePt: number, trackingEm?: number): number;
  /** Ascender and descender as fractions of the em (both positive). */
  ascent: number;
  descent: number;
  /** Characters the fonts cannot draw are decomposed or dropped. */
  clean(text: string): string;
};

export type BadgeTextOp = {
  kind: "text"; x: number; baseline: number; text: string; sizePt: number; weight: FontWeight; color: string; trackingEm: number;
  /** Watermarks only: clockwise rotation about (x, baseline), and 0–1 opacity. */
  rotateDeg?: number;
  opacity?: number;
};
export type BadgeOp =
  | { kind: "rect"; x: number; y: number; w: number; h: number; radius: number; fill?: string; stroke?: string; strokeWidth?: number }
  | BadgeTextOp
  /** `photo` marks the per-person photo, which renderers don't cache across badges. */
  | { kind: "image"; url: string; x: number; y: number; w: number; h: number; fit: "contain" | "cover"; shape: "none" | "circle" | "rounded"; grayscale: boolean; opacity?: number; photo?: true }
  | { kind: "qr"; value: string; x: number; y: number; size: number; dark: string; light: string }
  | { kind: "symbol"; variant: BadgeSymbolVariant; x: number; y: number; w: number; h: number };

export type BadgeScene = { widthMm: number; heightMm: number; background: string; ops: BadgeOp[] };

const ptMm = (pt: number) => pt * PT_TO_MM;

/** Break text into lines no wider than `maxMm`: at spaces, and inside words that are too long on their own. */
export function wrapText(text: string, maxMm: number, measure: (value: string) => number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  const pushWord = (word: string) => {
    // overflow-wrap: anywhere — split a word that cannot fit on a line of its own.
    let rest = word;
    while (rest && measure(rest) > maxMm) {
      let cut = 1;
      const chars = [...rest];
      while (cut < chars.length && measure(chars.slice(0, cut + 1).join("")) <= maxMm) cut += 1;
      lines.push(chars.slice(0, cut).join(""));
      rest = chars.slice(cut).join("");
    }
    current = rest;
  };
  for (const word of words) {
    if (!current) {
      pushWord(word);
      continue;
    }
    const candidate = `${current} ${word}`;
    if (measure(candidate) <= maxMm) current = candidate;
    else {
      lines.push(current);
      pushWord(word);
    }
  }
  if (current) lines.push(current);
  return lines;
}

type TextStyle = { sizePt: number; weight: FontWeight; color: string; trackingEm?: number; lineHeight: number };

/**
 * Lay out a left-aligned (or right-aligned) paragraph whose first line box
 * starts at `top`, using CSS half-leading so baselines match the browser.
 * Returns the ops and the bottom of the last line box.
 */
function paragraph(
  measurer: TextMeasurer,
  raw: string,
  x: number,
  top: number,
  widthMm: number,
  style: TextStyle,
  align: "left" | "right" = "left",
) {
  const text = measurer.clean(raw);
  const tracking = style.trackingEm ?? 0;
  const measure = (value: string) => measurer.widthMm(value, style.weight, style.sizePt, tracking);
  const lines = text ? wrapText(text, Math.max(1, widthMm), measure) : [];
  const size = ptMm(style.sizePt);
  const lineBox = size * style.lineHeight;
  const halfLeading = (lineBox - (measurer.ascent + measurer.descent) * size) / 2;
  const ops: BadgeTextOp[] = lines.map((line, index) => ({
    kind: "text",
    x: align === "right" ? x + widthMm - measure(line) : x,
    baseline: top + index * lineBox + halfLeading + measurer.ascent * size,
    text: line,
    sizePt: style.sizePt,
    weight: style.weight,
    color: style.color,
    trackingEm: tracking,
  }));
  return { ops, bottom: top + lines.length * lineBox, lines };
}

export type BadgeSceneInput = {
  settings: IdCardPrintSettings;
  attendee: IdCardAttendee;
  branding: BadgeBranding;
  measurer: TextMeasurer;
};

/** Which artwork a design will draw, so callers can load only what is needed. */
export function badgeImageUrls(settings: IdCardPrintSettings, branding: BadgeBranding, attendee?: Pick<IdCardAttendee, "photoUrl">) {
  return {
    organisationLogo: settings.showLogo ? branding.organisationLogoUrl : null,
    eventLogo: settings.showEventLogo ? branding.eventLogoUrl : null,
    sponsors: settings.showSponsors ? branding.sponsorLogoUrls.slice(0, settings.sponsorLimit) : [],
    photo: settings.showPhoto ? attendee?.photoUrl ?? null : null,
    watermark: settings.watermark.kind === "image" ? branding.watermarkUrl ?? null : null,
  };
}

/** Where a watermark image sits: centred, within 70% of the card. */
export function watermarkImageBox(widthMm: number, heightMm: number) {
  const w = widthMm * 0.7;
  const h = heightMm * 0.7;
  return { x: (widthMm - w) / 2, y: (heightMm - h) / 2, w, h };
}

/** The text a member ID item prints, or "" when there is nothing to print. */
export function memberLine(label: string, value: string | null | undefined) {
  const text = value?.trim();
  if (!text) return "";
  return label.trim() ? `${label.trim()} ${text}` : text;
}

export function buildBadgeScene({ settings: designSettings, attendee, branding, measurer }: BadgeSceneInput): BadgeScene {
  const settings = withMergeFields(designSettings, attendee);
  const palette: BadgePalette = resolveBadgePalette(settings, branding.eventAccent);
  const mono = settings.colorMode === "mono";
  const decor = idCardTemplateDecor(settings.template, settings.widthMm, settings.heightMm);
  const at = settings.elementPositions;
  const size = settings.elementSizes;
  const pt = settings.elementTextSizes;
  const bold = settings.elementBold;
  const weight = (on: boolean): FontWeight => (on ? 700 : 400);
  const ops: BadgeOp[] = [];
  const graphics: BadgeOp[] = [];
  const images = badgeImageUrls(settings, branding, attendee);

  // The watermark sits under everything else.
  const mark = settings.watermark;
  const markColour = mark.colour === "text" ? palette.text : palette.accent === palette.background ? palette.text : palette.accent;
  if (mark.kind === "text" && mark.text.trim()) {
    const text = measurer.clean(mark.text.trim().toLocaleUpperCase("en"));
    const sizePt = watermarkSizePt(text, settings.widthMm, settings.heightMm, mark.angleDeg);
    const width = measurer.widthMm(text, 700, sizePt, 0.04);
    const size = ptMm(sizePt);
    // Centre the text box on the card, then rotate its start point about the centre.
    const dx = -width / 2;
    const dy = ((measurer.ascent - measurer.descent) * size) / 2;
    const angle = (mark.angleDeg * Math.PI) / 180;
    ops.push({
      kind: "text",
      x: settings.widthMm / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
      baseline: settings.heightMm / 2 + dx * Math.sin(angle) + dy * Math.cos(angle),
      text,
      sizePt,
      weight: 700,
      color: markColour,
      trackingEm: 0.04,
      rotateDeg: mark.angleDeg,
      opacity: mark.opacityPct / 100,
    });
  } else if (images.watermark) {
    ops.push({ kind: "image", url: images.watermark, ...watermarkImageBox(settings.widthMm, settings.heightMm), fit: "contain", shape: "none", grayscale: mono, opacity: mark.opacityPct / 100 });
  }

  if (decor.frame) {
    ops.push({
      kind: "rect",
      x: decor.frame.insetMm,
      y: decor.frame.insetMm,
      w: settings.widthMm - 2 * decor.frame.insetMm,
      h: settings.heightMm - 2 * decor.frame.insetMm,
      radius: decor.frame.radiusMm,
      stroke: palette.rule,
      strokeWidth: decor.frame.ruleMm,
    });
  }

  // Heading block: badge label and heading, on the band (bold) or above a rule (classic).
  const label = settings.showBadgeLabel ? settings.badgeLabel.trim() : "";
  const heading = settings.heading.trim();
  if (label || heading) {
    const band = decor.band;
    const innerX = at.header.xMm + (band ? band.padXMm : 0);
    const innerWidth = size.header - (band ? 2 * band.padXMm : 0);
    const color = band ? palette.onAccent : palette.heading;
    let cursor = at.header.yMm + (band ? band.padYMm : 0);
    const texts: BadgeOp[] = [];
    if (label) {
      const block = paragraph(measurer, label, innerX, cursor, innerWidth, { sizePt: badgeLabelPt(pt.header), weight: weight(bold.header), color, trackingEm: 0.16, lineHeight: ID_CARD_LINE_HEIGHT.label });
      texts.push(...block.ops);
      cursor = block.bottom + decor.labelGapMm;
    }
    if (heading) {
      const block = paragraph(measurer, heading, innerX, cursor, innerWidth, { sizePt: pt.header, weight: weight(bold.header), color, trackingEm: -0.01, lineHeight: ID_CARD_LINE_HEIGHT.heading });
      texts.push(...block.ops);
      cursor = block.bottom;
    }
    if (band) {
      ops.push({ kind: "rect", x: at.header.xMm, y: at.header.yMm, w: size.header, h: cursor + band.padYMm - at.header.yMm, radius: band.radiusMm, fill: palette.accent });
    }
    ops.push(...texts);
    if (decor.headerRule) {
      ops.push({ kind: "rect", x: at.header.xMm, y: cursor + decor.headerRule.gapMm, w: size.header, h: decor.headerRule.ruleMm, radius: 0, fill: palette.rule });
    }
  }

  if (settings.showName) {
    const name = decor.nameUppercase ? attendee.displayName.toLocaleUpperCase("en") : attendee.displayName;
    ops.push(...paragraph(measurer, name, at.name.xMm, at.name.yMm, size.name, {
      sizePt: nameSizePt(settings, attendee.displayName),
      weight: weight(bold.name),
      color: palette.text,
      trackingEm: decor.nameTrackingEm,
      lineHeight: ID_CARD_LINE_HEIGHT.name,
    }).ops);
  }

  const idLine = settings.showIdNumber ? memberLine(settings.idNumberLabel, attendee.idNumber) : "";
  if (idLine) {
    ops.push(...paragraph(measurer, idLine, at.idNumber.xMm, at.idNumber.yMm, size.idNumber, { sizePt: pt.idNumber, weight: weight(bold.idNumber), color: palette.text, trackingEm: 0.02, lineHeight: ID_CARD_LINE_HEIGHT.body }).ops);
  }
  const validLine = settings.showValidUntil ? memberLine(settings.validUntilLabel, attendee.validUntil) : "";
  if (validLine) {
    ops.push(...paragraph(measurer, validLine, at.validUntil.xMm, at.validUntil.yMm, size.validUntil, { sizePt: pt.validUntil, weight: weight(bold.validUntil), color: palette.text, lineHeight: ID_CARD_LINE_HEIGHT.body }).ops);
  }

  if (settings.showEmail && attendee.email) {
    ops.push(...paragraph(measurer, attendee.email, at.email.xMm, at.email.yMm, size.email, { sizePt: pt.email, weight: weight(bold.email), color: palette.text, lineHeight: ID_CARD_LINE_HEIGHT.body }).ops);
  }

  const fields = printableFields(settings, attendee);
  if (fields.length > 0) {
    const style = { sizePt: pt.details, weight: weight(bold.details), color: palette.text, lineHeight: ID_CARD_LINE_HEIGHT.body };
    let cursor = at.details.yMm;
    for (const field of fields) {
      cursor += DETAILS_ROW_GAP_MM;
      const fieldLabel = settings.printFieldLabels[field.key] ?? field.label;
      let labelWidth = 0;
      let rowBottom = cursor;
      if (fieldLabel) {
        const natural = measurer.widthMm(measurer.clean(fieldLabel), style.weight, style.sizePt);
        labelWidth = Math.min(natural, size.details * 0.5);
        const block = paragraph(measurer, fieldLabel, at.details.xMm, cursor, labelWidth + 0.01, style);
        ops.push(...block.ops);
        rowBottom = block.bottom;
      }
      const valueX = fieldLabel ? at.details.xMm + labelWidth + DETAILS_COLUMN_GAP_MM : at.details.xMm;
      const valueWidth = at.details.xMm + size.details - valueX;
      const value = paragraph(measurer, field.value, valueX, cursor, valueWidth, style, fieldLabel ? "right" : "left");
      ops.push(...value.ops);
      cursor = Math.max(rowBottom, value.bottom);
    }
  }

  const footer = settings.showFooter ? settings.footerText.trim() : "";
  if (footer) {
    ops.push(...paragraph(measurer, footer, at.footer.xMm, at.footer.yMm, size.footer, {
      sizePt: pt.footer,
      weight: weight(bold.footer || settings.template === "bold"),
      color: palette.text,
      lineHeight: ID_CARD_LINE_HEIGHT.body,
    }).ops);
  }

  // Graphics sit above text, as in the preview.
  const logoTile = (x: number, y: number, side: number, url: string) => {
    graphics.push({ kind: "rect", x, y, w: side, h: side, radius: Math.min(3, side / 4), fill: palette.tile });
    graphics.push({ kind: "image", url, x: x + TILE_PADDING_MM, y: y + TILE_PADDING_MM, w: side - 2 * TILE_PADDING_MM, h: side - 2 * TILE_PADDING_MM, fit: "contain", shape: "none", grayscale: mono });
  };
  if (images.organisationLogo) logoTile(at.logo.xMm, at.logo.yMm, size.logo, images.organisationLogo);
  if (images.eventLogo) logoTile(at.eventLogo.xMm, at.eventLogo.yMm, size.eventLogo, images.eventLogo);

  if (images.sponsors.length > 0) {
    const stripHeight = sponsorStripHeightMm(settings.widthMm, settings.heightMm);
    const pad = TILE_PADDING_MM;
    const gap = 2;
    const count = images.sponsors.length;
    const slotWidth = (size.sponsors - 2 * pad - gap * (count - 1)) / count;
    graphics.push({ kind: "rect", x: at.sponsors.xMm, y: at.sponsors.yMm, w: size.sponsors, h: stripHeight, radius: Math.min(2, stripHeight / 4), fill: palette.tile });
    images.sponsors.forEach((url, index) => {
      graphics.push({ kind: "image", url, x: at.sponsors.xMm + pad + index * (slotWidth + gap), y: at.sponsors.yMm + pad, w: slotWidth, h: stripHeight - 2 * pad, fit: "contain", shape: "none", grayscale: mono });
    });
  }

  if (settings.showPhoto) {
    const side = size.photo;
    const shape = settings.photoShape;
    if (images.photo) {
      graphics.push({ kind: "image", url: images.photo, x: at.photo.xMm, y: at.photo.yMm, w: side, h: side, fit: "cover", shape, grayscale: mono, photo: true });
    } else {
      graphics.push({ kind: "rect", x: at.photo.xMm, y: at.photo.yMm, w: side, h: side, radius: shape === "circle" ? side / 2 : side * 0.2, fill: palette.photoPlaceholder });
      const initials = measurer.clean(attendeeInitials(attendee.displayName)) || "?";
      const sizePt = (side * 0.36) / PT_TO_MM;
      const width = measurer.widthMm(initials, 700, sizePt);
      graphics.push({
        kind: "text",
        x: at.photo.xMm + (side - width) / 2,
        baseline: at.photo.yMm + side / 2 + ((measurer.ascent - measurer.descent) * ptMm(sizePt)) / 2 - ptMm(sizePt) * 0.08,
        text: initials,
        sizePt,
        weight: 700,
        color: palette.onPhotoPlaceholder,
        trackingEm: 0,
      });
    }
  }

  if (settings.showSymbol) {
    const side = size.symbol;
    const h = side / SYMBOL_ASPECT;
    graphics.push({ kind: "symbol", variant: palette.symbol, x: at.symbol.xMm, y: at.symbol.yMm + (side - h) / 2, w: side, h });
  }

  if (settings.showQr) {
    graphics.push({ kind: "rect", x: at.qr.xMm, y: at.qr.yMm, w: size.qr + 2 * TILE_PADDING_MM, h: size.qr + 2 * TILE_PADDING_MM, radius: 0, fill: palette.qrLight });
    graphics.push({ kind: "qr", value: attendee.checkInQrToken, x: at.qr.xMm + TILE_PADDING_MM, y: at.qr.yMm + TILE_PADDING_MM, size: size.qr, dark: palette.qrDark, light: palette.qrLight });
  }

  return { widthMm: settings.widthMm, heightMm: settings.heightMm, background: palette.background, ops: [...ops, ...graphics] };
}
