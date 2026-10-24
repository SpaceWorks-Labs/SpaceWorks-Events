"use client";

import type { CSSProperties, ReactNode } from "react";
import QRCode from "react-qr-code";
import {
  badgeLabelPt,
  DETAILS_COLUMN_GAP_MM,
  DETAILS_ROW_GAP_MM,
  elementBoxHeightMm,
  ID_CARD_LINE_HEIGHT,
  idCardTemplateDecor,
  nameSizePt,
  PT_TO_MM,
  sponsorStripHeightMm,
  TILE_PADDING_MM,
  type IdCardLayoutElement,
  type IdCardPrintSettings,
} from "@/lib/idCardPrint";
import { badgeImageUrls, memberLine } from "@/lib/badge/layout";
import { resolveBadgePalette, SYMBOL_ASSET } from "@/lib/badge/palette";
import { attendeeInitials, printableFields, type BadgeBranding, type IdCardAttendee } from "@/lib/badge/types";
import { SAFE_MARGIN_MM, withMergeFields } from "./shared";
import { BADGE_FONT_FAMILY } from "./BadgeCanvas/fonts";
import { BadgeWatermark } from "./BadgeCanvas/BadgeWatermark";
import type { CanvasInteraction } from "./BadgeCanvas/types";
import { useBadgeItemProps } from "./BadgeCanvas/useBadgeItemProps";

export { BADGE_FONT_FAMILY, badgeFontFaceCss, BadgeFontFaces } from "./BadgeCanvas/fonts";
export type { CanvasInteraction } from "./BadgeCanvas/types";

/**
 * One badge drawn to scale, matching the printed card and the server-rendered
 * PDF/PNG (lib/badge/layout.ts draws the same boxes, palette and decor). With
 * `interaction`, items can be selected, dragged and nudged with the arrow keys
 * (Shift for bigger steps); without it, it is a static preview. `unit="mm"`
 * draws in real millimetres for the browser print sheet.
 */
export function BadgeCanvas({
  settings: designSettings,
  attendee,
  branding,
  pxPerMm = 1,
  unit = "px",
  interaction,
}: {
  settings: IdCardPrintSettings;
  attendee: IdCardAttendee;
  branding: BadgeBranding;
  pxPerMm?: number;
  unit?: "px" | "mm";
  interaction?: CanvasInteraction;
}) {
  // `{{team}}` is filled per attendee; geometry is unchanged, so dragging still edits the design.
  const settings = withMergeFields(designSettings, attendee);
  const itemProps = useBadgeItemProps(settings, pxPerMm, interaction);
  const print = unit === "mm";
  const px = (mm: number) => (print ? `${mm}mm` : `${mm * pxPerMm}px`);
  const ptPx = (pt: number) => (print ? `${pt}pt` : `${pt * PT_TO_MM * pxPerMm}px`);
  const bold = settings.elementBold;
  const fields = printableFields(settings, attendee);
  const editing = Boolean(interaction);
  const palette = resolveBadgePalette(settings, branding.eventAccent);
  const mono = settings.colorMode === "mono";
  const images = badgeImageUrls(settings, branding, attendee);
  const weight = (on: boolean) => (on ? 700 : 400);

  const itemStyle = (element: IdCardLayoutElement, extra: CSSProperties = {}): CSSProperties => ({
    position: "absolute",
    left: px(settings.elementPositions[element].xMm),
    top: px(settings.elementPositions[element].yMm),
    cursor: editing ? "grab" : undefined,
    touchAction: editing ? "none" : undefined,
    userSelect: editing ? "none" : undefined,
    zIndex: interaction?.selected === element ? 3 : 1,
    ...extra,
  });

  const decor = idCardTemplateDecor(settings.template, settings.widthMm, settings.heightMm);
  // On screen, rules stay at least one pixel wide so they never vanish in the preview.
  const rule = (mm: number, color: string) => `${print ? `${mm}mm` : `${Math.max(1, mm * pxPerMm)}px`} solid ${color}`;
  const cardStyle: CSSProperties = {
    width: px(settings.widthMm),
    height: px(settings.heightMm),
    position: "relative",
    backgroundColor: palette.background,
    color: palette.text,
    overflow: "hidden",
    fontFamily: BADGE_FONT_FAMILY,
    lineHeight: ID_CARD_LINE_HEIGHT.body,
    WebkitPrintColorAdjust: "exact",
    printColorAdjust: "exact",
    // The paper edge, on screen only: an outline takes no room, so items sit exactly where they print.
    outline: print ? undefined : "1px solid rgb(20 44 42 / 14%)",
    backgroundImage: interaction?.showGrid
      ? "linear-gradient(to right, rgb(0 110 99 / 10%) 1px, transparent 1px), linear-gradient(to bottom, rgb(0 110 99 / 10%) 1px, transparent 1px)"
      : undefined,
    backgroundSize: interaction?.showGrid ? `${settings.gridSizeMm * pxPerMm}px ${settings.gridSizeMm * pxPerMm}px` : undefined,
  };

  const label = settings.showBadgeLabel ? settings.badgeLabel.trim() : "";
  const showHeader = label || settings.heading.trim();
  let headerDecor: CSSProperties = { color: palette.heading };
  if (decor.headerRule) headerDecor = { ...headerDecor, paddingBottom: px(decor.headerRule.gapMm), borderBottom: rule(decor.headerRule.ruleMm, palette.rule) };
  // Bold: the heading block is a solid band in the accent colour, with text picked for contrast.
  if (decor.band) headerDecor = { padding: `${px(decor.band.padYMm)} ${px(decor.band.padXMm)}`, background: palette.accent, color: palette.onAccent, borderRadius: px(decor.band.radiusMm) };

  const tile = (element: "logo" | "eventLogo", url: string) => (
    // eslint-disable-next-line @next/next/no-img-element -- managed upload drawn to scale on the badge
    <img
      {...itemProps(element)}
      key={element}
      src={url}
      alt=""
      draggable={false}
      style={itemStyle(element, {
        width: px(settings.elementSizes[element]),
        height: px(settings.elementSizes[element]),
        objectFit: "contain",
        padding: px(TILE_PADDING_MM),
        borderRadius: px(Math.min(3, settings.elementSizes[element] / 4)),
        background: palette.tile,
        filter: mono ? "grayscale(1)" : undefined,
        zIndex: interaction?.selected === element ? 3 : 2,
      })}
    />
  );

  const photoSide = settings.elementSizes.photo;
  const photoRadius = settings.photoShape === "circle" ? "50%" : px(photoSide * 0.2);
  const stripHeight = sponsorStripHeightMm(settings.widthMm, settings.heightMm);

  const idLine = settings.showIdNumber ? memberLine(settings.idNumberLabel, attendee.idNumber) : "";
  const validLine = settings.showValidUntil ? memberLine(settings.validUntilLabel, attendee.validUntil) : "";

  let content: ReactNode = (
    <>
      <BadgeWatermark settings={settings} palette={palette} watermarkUrl={images.watermark} mono={mono} px={px} ptPx={ptPx} />
      {decor.frame ? (
        <span aria-hidden style={{ position: "absolute", inset: px(decor.frame.insetMm), border: rule(decor.frame.ruleMm, palette.rule), borderRadius: px(decor.frame.radiusMm), pointerEvents: "none" }} />
      ) : null}
      {interaction ? (
        <span aria-hidden style={{ position: "absolute", inset: px(SAFE_MARGIN_MM), border: "1px dashed rgb(0 110 99 / 40%)", pointerEvents: "none" }} />
      ) : null}

      {showHeader ? (
        <div {...itemProps("header")} style={itemStyle("header", { width: px(settings.elementSizes.header), ...headerDecor })}>
          {label ? (
            <p style={{ margin: `0 0 ${px(decor.labelGapMm)}`, fontSize: ptPx(badgeLabelPt(settings.elementTextSizes.header)), lineHeight: ID_CARD_LINE_HEIGHT.label, letterSpacing: "0.16em", fontWeight: weight(bold.header), overflowWrap: "anywhere" }}>{label}</p>
          ) : null}
          {settings.heading.trim() ? (
            <p style={{ margin: 0, fontSize: ptPx(settings.elementTextSizes.header), fontWeight: weight(bold.header), lineHeight: ID_CARD_LINE_HEIGHT.heading, letterSpacing: "-0.01em", overflowWrap: "anywhere" }}>{settings.heading}</p>
          ) : null}
        </div>
      ) : null}

      {settings.showName ? (
      <p
        {...itemProps("name")}
        style={itemStyle("name", {
          margin: 0,
          width: px(settings.elementSizes.name),
          fontSize: ptPx(nameSizePt(settings, attendee.displayName)),
          fontWeight: weight(bold.name),
          lineHeight: ID_CARD_LINE_HEIGHT.name,
          letterSpacing: `${decor.nameTrackingEm}em`,
          textTransform: decor.nameUppercase ? "uppercase" : undefined,
          overflowWrap: "anywhere",
        })}
      >
        {attendee.displayName}
      </p>
      ) : null}

      {idLine ? (
        <p {...itemProps("idNumber")} style={itemStyle("idNumber", { margin: 0, width: px(settings.elementSizes.idNumber), fontSize: ptPx(settings.elementTextSizes.idNumber), lineHeight: ID_CARD_LINE_HEIGHT.body, fontWeight: weight(bold.idNumber), letterSpacing: "0.02em", fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" })}>
          {idLine}
        </p>
      ) : null}

      {validLine ? (
        <p {...itemProps("validUntil")} style={itemStyle("validUntil", { margin: 0, width: px(settings.elementSizes.validUntil), fontSize: ptPx(settings.elementTextSizes.validUntil), lineHeight: ID_CARD_LINE_HEIGHT.body, fontWeight: weight(bold.validUntil), overflowWrap: "anywhere" })}>
          {validLine}
        </p>
      ) : null}

      {settings.showEmail && attendee.email ? (
        <p {...itemProps("email")} style={itemStyle("email", { margin: 0, width: px(settings.elementSizes.email), fontSize: ptPx(settings.elementTextSizes.email), lineHeight: ID_CARD_LINE_HEIGHT.body, fontWeight: weight(bold.email), overflowWrap: "anywhere" })}>
          {attendee.email}
        </p>
      ) : null}

      {fields.length > 0 ? (
        <div {...itemProps("details")} style={itemStyle("details", { width: px(settings.elementSizes.details), lineHeight: ID_CARD_LINE_HEIGHT.body })}>
          {fields.map((detail) => {
            const fieldLabel = settings.printFieldLabels[detail.key] ?? detail.label;
            return (
              <div key={detail.key} style={{ display: "flex", justifyContent: fieldLabel ? "space-between" : "flex-start", gap: px(DETAILS_COLUMN_GAP_MM), marginTop: px(DETAILS_ROW_GAP_MM), fontSize: ptPx(settings.elementTextSizes.details), fontWeight: weight(bold.details) }}>
                {fieldLabel ? <span style={{ maxWidth: "50%", overflowWrap: "anywhere" }}>{fieldLabel}</span> : null}
                <span style={{ textAlign: fieldLabel ? "right" : "left", overflowWrap: "anywhere" }}>{detail.value}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      {settings.showFooter && settings.footerText.trim() ? (
        <p {...itemProps("footer")} style={itemStyle("footer", { margin: 0, width: px(settings.elementSizes.footer), fontSize: ptPx(settings.elementTextSizes.footer), lineHeight: ID_CARD_LINE_HEIGHT.body, fontWeight: weight(bold.footer || settings.template === "bold"), overflowWrap: "anywhere" })}>
          {settings.footerText}
        </p>
      ) : null}

      {images.organisationLogo ? tile("logo", images.organisationLogo) : null}
      {images.eventLogo ? tile("eventLogo", images.eventLogo) : null}

      {images.sponsors.length > 0 ? (
        <div
          {...itemProps("sponsors")}
          style={itemStyle("sponsors", {
            width: px(settings.elementSizes.sponsors),
            height: px(stripHeight),
            display: "flex",
            gap: px(2),
            padding: px(TILE_PADDING_MM),
            borderRadius: px(Math.min(2, stripHeight / 4)),
            background: palette.tile,
            zIndex: interaction?.selected === "sponsors" ? 3 : 2,
          })}
        >
          {images.sponsors.map((url, index) => (
            // eslint-disable-next-line @next/next/no-img-element -- managed sponsor upload drawn to scale
            <img key={`${url}-${index}`} src={url} alt="" draggable={false} style={{ flex: "1 1 0", minWidth: 0, height: "100%", objectFit: "contain", filter: mono ? "grayscale(1)" : undefined }} />
          ))}
        </div>
      ) : null}

      {settings.showPhoto ? (
        images.photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- the attendee's own uploaded photo
          <img
            {...itemProps("photo")}
            src={images.photo}
            alt=""
            draggable={false}
            style={itemStyle("photo", { width: px(photoSide), height: px(photoSide), objectFit: "cover", borderRadius: photoRadius, filter: mono ? "grayscale(1)" : undefined, zIndex: interaction?.selected === "photo" ? 3 : 2 })}
          />
        ) : (
          <div
            {...itemProps("photo")}
            style={itemStyle("photo", {
              width: px(photoSide),
              height: px(photoSide),
              borderRadius: photoRadius,
              background: palette.photoPlaceholder,
              color: palette.onPhotoPlaceholder,
              display: "grid",
              placeItems: "center",
              fontSize: ptPx((photoSide * 0.36) / PT_TO_MM),
              fontWeight: 700,
              lineHeight: 1,
              zIndex: interaction?.selected === "photo" ? 3 : 2,
            })}
          >
            {attendeeInitials(attendee.displayName)}
          </div>
        )
      ) : null}

      {settings.showSymbol ? (
        // eslint-disable-next-line @next/next/no-img-element -- the unaltered Space Works master symbol
        <img
          {...itemProps("symbol")}
          src={SYMBOL_ASSET[palette.symbol]}
          alt=""
          draggable={false}
          style={itemStyle("symbol", {
            width: px(settings.elementSizes.symbol),
            height: px(settings.elementSizes.symbol),
            objectFit: "contain",
            zIndex: interaction?.selected === "symbol" ? 3 : 2,
          })}
        />
      ) : null}

      {settings.showQr ? (
      <div {...itemProps("qr")} style={itemStyle("qr", { background: palette.qrLight, padding: px(TILE_PADDING_MM), lineHeight: 0, zIndex: interaction?.selected === "qr" ? 3 : 2 })}>
        <QRCode
          value={attendee.checkInQrToken}
          size={print ? 256 : Math.max(16, Math.round(settings.elementSizes.qr * pxPerMm))}
          style={print ? { width: px(settings.elementSizes.qr), height: px(settings.elementSizes.qr) } : undefined}
          bgColor={palette.qrLight}
          fgColor={palette.qrDark}
          level="M"
        />
      </div>
      ) : null}
    </>
  );

  if (!interaction) content = <div aria-hidden>{content}</div>;
  return (
    <div data-id-card-preview style={cardStyle} className={print ? undefined : "shrink-0"}>
      {content}
    </div>
  );
}

/** Height the designer keeps clear when it clamps an item to the card. */
export function elementHeightForMove(settings: IdCardPrintSettings, element: IdCardLayoutElement) {
  return elementBoxHeightMm(element, settings.elementSizes, settings.widthMm, settings.heightMm);
}
