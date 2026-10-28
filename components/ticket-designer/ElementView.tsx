"use client";

import type { CSSProperties } from "react";
import { QrCode } from "lucide-react";
import { fillMergeFields, SAMPLE_VALUES } from "@/lib/ticketDesign/fields";
import type { DesignElement } from "@/lib/ticketDesign/schema";

/**
 * One element drawn in the editor at `scale` pixels per millimetre, with the
 * same fonts as the renderer (docs/TICKET_DESIGNER.md). Merge fields show
 * sample values; the QR shows a placeholder (the real code is the ticket's).
 */

const PT_TO_MM = 0.3528;
export const EDITOR_FONT_FAMILY: Record<string, string> = {
  gilroy: "'TD Gilroy', sans-serif",
  unbounded: "'TD Unbounded', sans-serif",
  "dejavu-sans": "'TD DejaVu Sans', sans-serif",
  "dejavu-serif": "'TD DejaVu Serif', serif",
};

/** The fonts the renderer uses, declared for the editor under their own names. */
export const EDITOR_FONT_FACES = [
  ["TD Gilroy", "/brand/fonts/Gilroy-Regular.woff", 400], ["TD Gilroy", "/brand/fonts/Gilroy-Medium.woff", 500],
  ["TD Gilroy", "/brand/fonts/Gilroy-SemiBold.woff", 600], ["TD Gilroy", "/brand/fonts/Gilroy-Bold.woff", 700],
  ["TD Unbounded", "/brand/fonts/Unbounded-Variable.woff2", 400],
  ["TD DejaVu Sans", "/fonts/dejavu/DejaVuSans.ttf", 400], ["TD DejaVu Sans", "/fonts/dejavu/DejaVuSans-Bold.ttf", 700],
  ["TD DejaVu Serif", "/fonts/dejavu/DejaVuSerif.ttf", 400], ["TD DejaVu Serif", "/fonts/dejavu/DejaVuSerif-Bold.ttf", 700],
].map(([family, url, weight]) => `@font-face{font-family:"${family}";src:url("${url}");font-weight:${weight};font-style:normal;font-display:block}`).join("");

export function boxStyle(element: DesignElement, scale: number): CSSProperties {
  return {
    position: "absolute",
    left: element.x * scale,
    top: element.y * scale,
    width: element.w * scale,
    height: element.h * scale,
    transform: element.kind !== "qr" && element.rotation ? `rotate(${element.rotation}deg)` : undefined,
    opacity: element.kind !== "qr" ? element.opacity : 1,
  };
}

export function ElementView({ element, scale }: { element: DesignElement; scale: number; }) {
  if (element.kind === "text") {
    const sizePx = element.sizePt * PT_TO_MM * scale;
    return (
      <div
        style={{
          fontFamily: EDITOR_FONT_FAMILY[element.font], fontWeight: element.weight, fontSize: sizePx, lineHeight: element.lineHeight,
          letterSpacing: `${element.letterSpacing}em`, color: element.color, textAlign: element.align, textTransform: element.uppercase ? "uppercase" : undefined,
          whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflow: "hidden", width: "100%", height: "100%",
        }}
      >
        {fillMergeFields(element.text, SAMPLE_VALUES)}
      </div>
    );
  }
  if (element.kind === "rect" || element.kind === "ellipse") {
    return (
      <div
        style={{
          width: "100%", height: "100%", boxSizing: "border-box", background: element.fill ?? "transparent",
          border: element.stroke ? `${element.strokeWidthMm * scale}px solid ${element.stroke}` : undefined,
          borderRadius: element.kind === "ellipse" ? "50%" : element.radiusMm * scale,
        }}
      />
    );
  }
  if (element.kind === "line") {
    return (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center" }}>
        <div style={{ width: "100%", borderTop: `${Math.max(1, element.strokeWidthMm * scale)}px ${element.dashed ? "dashed" : "solid"} ${element.color}` }} />
      </div>
    );
  }
  if (element.kind === "image") {
    return element.url ? (
      // eslint-disable-next-line @next/next/no-img-element -- a managed upload drawn at the canvas scale
      <img src={element.url} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: element.fit, borderRadius: element.radiusMm * scale }} />
    ) : null;
  }
  const side = Math.min(element.w, element.h) * scale;
  return (
    // Ticket ink, not interface colour: the QR is always black on a white plate.
    <div aria-hidden className="outline-1 outline-dashed outline-line-strong" style={{ width: side, height: side, background: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <QrCode style={{ width: side * 0.8, height: side * 0.8, color: "#000000" }} />
    </div>
  );
}
