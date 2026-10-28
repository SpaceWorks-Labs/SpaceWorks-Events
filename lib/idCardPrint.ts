import { DEFAULT_LAYOUT_FLAGS, layoutFlags, type IdCardLayoutFlags, type IdCardPrintSettings } from "./idCardPrint/model";
import { defaultIdCardElementBold, defaultIdCardElementTextSizes, geometryWithOptionalDefaults } from "./idCardPrint/defaults";
import { normalizeIdCardPrintSettings } from "./idCardPrint/normalize";

export {
  A6_LANDSCAPE,
  A6_PORTRAIT,
  CR80,
  DEFAULT_LAYOUT_FLAGS,
  DEFAULT_WATERMARK,
  DETAILS_COLUMN_GAP_MM,
  DETAILS_ROW_GAP_MM,
  ID_CARD_GRID_SIZES_MM,
  ID_CARD_LAYOUT_ELEMENTS,
  ID_CARD_LINE_HEIGHT,
  ID_CARD_PAPER_PRESETS,
  layoutFlags,
  matchPaperPreset,
  PT_TO_MM,
  SPONSOR_LIMIT_MAX,
  TILE_PADDING_MM,
  WATERMARK_COLOURS,
  WATERMARK_KINDS,
  WATERMARK_OPACITY_MAX,
  WATERMARK_OPACITY_MIN,
} from "./idCardPrint/model";
export type {
  IdCardElementBold,
  IdCardElementPosition,
  IdCardElementPositions,
  IdCardElementSizes,
  IdCardElementTextSizes,
  IdCardGridSizeMm,
  IdCardLayoutElement,
  IdCardLayoutFlags,
  IdCardPrintSettings,
  IdCardWatermark,
} from "./idCardPrint/model";
export {
  badgeLabelPt,
  elementBoxHeightMm,
  estimateHeaderHeightMm,
  fitTextSizePt,
  idCardTemplateDecor,
  isSquareElement,
  isTextElement,
  minimumElementSizeMm,
  nameBlockHeightMm,
  nameSizePt,
  paperScale,
  sponsorStripHeightMm,
  symbolClearSpaceMm,
  watermarkSizePt,
} from "./idCardPrint/geometry";
export type { IdCardTemplateDecor } from "./idCardPrint/geometry";
export {
  defaultIdCardElementBold,
  defaultIdCardElementPositions,
  defaultIdCardElementSizes,
  defaultIdCardElementTextSizes,
  defaultIdCardPrintSettings,
} from "./idCardPrint/defaults";
export { FOOTER_MAX_LENGTH, normalizeIdCardPrintSettings } from "./idCardPrint/normalize";

/** A fresh layout for `template` on the given paper: positions, sizes and text sizes together. */
export function layoutForPaper(
  template: IdCardPrintSettings["template"],
  widthMm: number,
  heightMm: number,
  flags: IdCardLayoutFlags = DEFAULT_LAYOUT_FLAGS,
) {
  const geometry = geometryWithOptionalDefaults(template, widthMm, heightMm, flags);
  return {
    elementPositions: geometry.positions,
    elementSizes: geometry.sizes,
    elementTextSizes: defaultIdCardElementTextSizes(template, widthMm, heightMm),
    elementBold: defaultIdCardElementBold(),
  };
}

/**
 * True when the layout is still exactly the default for these flags, so
 * turning an optional item on may reflow the whole card without losing any
 * hand-made adjustments.
 */
export function isDefaultLayout(settings: IdCardPrintSettings, flags: IdCardLayoutFlags = layoutFlags(settings)) {
  const fresh = layoutForPaper(settings.template, settings.widthMm, settings.heightMm, flags);
  return JSON.stringify(fresh.elementPositions) === JSON.stringify(settings.elementPositions)
    && JSON.stringify(fresh.elementSizes) === JSON.stringify(settings.elementSizes);
}

const DESIGN_FILE_KIND = "swe-id-card-design";
/** Files exported before the rename are still accepted. */
const LEGACY_DESIGN_FILE_KINDS = ["yuyu-id-card-design"];

/** A portable design file, for copying a badge design to another event or desk. */
export function exportIdCardDesign(settings: IdCardPrintSettings): string {
  return JSON.stringify({ kind: DESIGN_FILE_KIND, version: 2, settings }, null, 2);
}

/** Read a design file; anything unexpected is normalised or rejected, never trusted. */
export function importIdCardDesign(text: string, eventTitle: string, organisationName = ""): IdCardPrintSettings | null {
  try {
    const parsed = JSON.parse(text) as { kind?: unknown; settings?: unknown };
    const kind = parsed?.kind;
    if (!parsed || typeof kind !== "string" || (kind !== DESIGN_FILE_KIND && !LEGACY_DESIGN_FILE_KINDS.includes(kind))) return null;
    if (!parsed.settings || typeof parsed.settings !== "object") return null;
    return normalizeIdCardPrintSettings(parsed.settings, eventTitle, organisationName);
  } catch {
    return null;
  }
}

/* ---------- Merge fields (docs/TEAMS.md) ---------- */

/** Typed into the heading, badge label or footer; replaced by the attendee's team name (empty when solo). */
export const ID_CARD_TEAM_MERGE_FIELD = "{{team}}";

/** The printable "Team" line in the answers list. Not a registration question, so it has its own prefix. */
export const ID_CARD_TEAM_FIELD_KEY = "attendee:team";

const TEAM_MERGE_PATTERN = /\{\{\s*team\s*\}\}/gi;

/**
 * Fill `{{team}}` in a badge text. Text without a merge field is returned
 * untouched; with one, the result is trimmed and doubled spaces collapsed so
 * a solo attendee's badge does not print a gap.
 */
export function applyIdCardMergeFields(text: string, values: { team?: string | null }): string {
  if (!text.match(TEAM_MERGE_PATTERN)) return text;
  return text.replace(TEAM_MERGE_PATTERN, (values.team ?? "").trim()).replace(/ {2,}/g, " ").trim();
}

/** Upper bound for a stored design, in bytes of JSON. */
export const BADGE_DESIGN_MAX_BYTES = 32_000;
