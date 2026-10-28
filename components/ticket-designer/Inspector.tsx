"use client";

import type { ReactNode } from "react";
import { CheckboxField } from "@/components/ui/choice";
import { Dropdown, Field, Input, Textarea } from "@/components/ui/field";
import { MERGE_FIELDS } from "@/lib/ticketDesign/fields";
import { CANVAS_PRESETS } from "@/lib/ticketDesign/presets";
import { FONT_LABELS, FONT_WEIGHTS, TICKET_FONTS, type DesignDocument, type DesignElement, type TicketFont } from "@/lib/ticketDesign/schema";

/** Properties of the selected element, or of the canvas when nothing is selected (docs/TICKET_DESIGNER.md). */

const WEIGHT_LABELS: Record<number, string> = { 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold" };

/** Committed on blur or Enter, so typing "-" or clearing the field never writes a 0. */
function NumberField({ label, value, onChange, step = 0.5, min, max, suffix }: { label: string; value: number; onChange: (value: number) => void; step?: number; min?: number; max?: number; suffix?: string; }) {
  const commit = (input: HTMLInputElement) => {
    const next = input.valueAsNumber;
    if (input.value.trim() === "" || !Number.isFinite(next)) input.value = String(Number(value.toFixed(2)));
    else if (next !== value) onChange(next);
  };
  return (
    <Field label={suffix ? `${label} (${suffix})` : label}>
      <Input type="number" inputMode="decimal" step={step} min={min} max={max} defaultValue={Number(value.toFixed(2))} key={value} onBlur={(event) => commit(event.target)} onKeyDown={(event) => { if (event.key === "Enter") commit(event.currentTarget); }} />
    </Field>
  );
}

function ColourField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void; }) {
  return (
    <Field label={label}>
      <Input type="color" value={value} onChange={(event) => onChange(event.target.value.toUpperCase())} className="h-11 p-1" />
    </Field>
  );
}

const Grid = ({ children }: { children: ReactNode; }) => <div className="grid grid-cols-2 gap-3">{children}</div>;

export function CanvasInspector({ document, onChange }: { document: DesignDocument; onChange: (patch: Partial<DesignDocument>) => void; }) {
  const preset = CANVAS_PRESETS.find((candidate) => candidate.widthMm === document.widthMm && candidate.heightMm === document.heightMm)?.key ?? "custom";
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-h4 text-ink">Ticket</h3>
      <Field label="Size">
        <Dropdown value={preset} onChange={(event) => { const chosen = CANVAS_PRESETS.find((candidate) => candidate.key === event.target.value); if (chosen) onChange({ widthMm: chosen.widthMm, heightMm: chosen.heightMm }); }}>
          {CANVAS_PRESETS.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
          <option value="custom">Custom</option>
        </Dropdown>
      </Field>
      <Grid>
        <NumberField label="Width" suffix="mm" value={document.widthMm} min={40} max={300} step={1} onChange={(widthMm) => onChange({ widthMm })} />
        <NumberField label="Height" suffix="mm" value={document.heightMm} min={40} max={300} step={1} onChange={(heightMm) => onChange({ heightMm })} />
      </Grid>
      <ColourField label="Background" value={document.background} onChange={(background) => onChange({ background })} />
      <p className="text-caption text-ink-muted">Every ticket keeps one check-in QR code on a white plate, at least 18 mm wide, so the door can scan it.</p>
    </div>
  );
}

export function ElementInspector({ element, onChange, onReplaceImage }: { element: DesignElement; onChange: (patch: Partial<DesignElement>) => void; onReplaceImage: () => void; }) {
  const qr = element.kind === "qr";
  return (
    <div className="flex flex-col gap-4">
      <Field label="Layer name" optional><Input value={element.name ?? ""} maxLength={60} onChange={(event) => onChange({ name: event.target.value || undefined })} /></Field>
      <Grid>
        <NumberField label="X" suffix="mm" value={element.x} onChange={(x) => onChange({ x })} />
        <NumberField label="Y" suffix="mm" value={element.y} onChange={(y) => onChange({ y })} />
        <NumberField label="Width" suffix="mm" value={element.w} min={0.5} onChange={(w) => onChange(qr ? { w, h: w } : { w })} />
        {qr ? null : <NumberField label="Height" suffix="mm" value={element.h} min={0.5} onChange={(h) => onChange({ h })} />}
        {qr ? null : <NumberField label="Rotation" suffix="°" value={element.rotation} step={1} min={-360} max={360} onChange={(rotation) => onChange({ rotation })} />}
        {qr ? null : <NumberField label="Opacity" suffix="%" value={element.opacity * 100} step={5} min={0} max={100} onChange={(opacity) => onChange({ opacity: Math.min(1, Math.max(0, opacity / 100)) })} />}
      </Grid>
      {element.kind === "text" ? (
        <>
          <Field label="Text" helperText="Fields in {{braces}} are filled for each ticket.">
            <Textarea value={element.text} maxLength={500} rows={3} onChange={(event) => onChange({ text: event.target.value })} />
          </Field>
          <Field label="Insert a field">
            <Dropdown value="" onChange={(event) => { if (event.target.value) onChange({ text: `${element.text}{{${event.target.value}}}` }); }}>
              <option value="">Choose a field…</option>
              {MERGE_FIELDS.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
            </Dropdown>
          </Field>
          <Grid>
            <Field label="Font">
              <Dropdown value={element.font} onChange={(event) => { const font = event.target.value as TicketFont; onChange({ font, weight: FONT_WEIGHTS[font].includes(element.weight) ? element.weight : FONT_WEIGHTS[font][0]! }); }}>
                {TICKET_FONTS.map((font) => <option key={font} value={font}>{FONT_LABELS[font]}</option>)}
              </Dropdown>
            </Field>
            <Field label="Weight">
              <Dropdown value={String(element.weight)} onChange={(event) => onChange({ weight: Number(event.target.value) })}>
                {FONT_WEIGHTS[element.font].map((weight) => <option key={weight} value={weight}>{WEIGHT_LABELS[weight] ?? weight}</option>)}
              </Dropdown>
            </Field>
            <NumberField label="Size" suffix="pt" value={element.sizePt} min={4} max={200} onChange={(sizePt) => onChange({ sizePt })} />
            <ColourField label="Colour" value={element.color} onChange={(color) => onChange({ color })} />
            <Field label="Align">
              <Dropdown value={element.align} onChange={(event) => onChange({ align: event.target.value as "left" | "center" | "right" })}>
                <option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option>
              </Dropdown>
            </Field>
            <NumberField label="Line height" value={element.lineHeight} step={0.05} min={0.8} max={3} onChange={(lineHeight) => onChange({ lineHeight })} />
            <NumberField label="Letter spacing" suffix="em" value={element.letterSpacing} step={0.01} min={-0.2} max={1} onChange={(letterSpacing) => onChange({ letterSpacing })} />
          </Grid>
          <CheckboxField checked={Boolean(element.uppercase)} onCheckedChange={(checked) => onChange({ uppercase: checked === true || undefined })} label="Capitals" />
        </>
      ) : null}
      {element.kind === "rect" || element.kind === "ellipse" ? (
        <>
          <CheckboxField checked={element.fill !== null} onCheckedChange={(checked) => onChange({ fill: checked === true ? "#E8F3F1" : null })} label="Fill" />
          {element.fill ? <ColourField label="Fill colour" value={element.fill} onChange={(fill) => onChange({ fill })} /> : null}
          <CheckboxField checked={element.stroke !== null} onCheckedChange={(checked) => onChange({ stroke: checked === true ? "#1A1A1A" : null })} label="Border" />
          {element.stroke ? (
            <Grid>
              <ColourField label="Border colour" value={element.stroke} onChange={(stroke) => onChange({ stroke })} />
              <NumberField label="Border" suffix="mm" value={element.strokeWidthMm} step={0.1} min={0} max={20} onChange={(strokeWidthMm) => onChange({ strokeWidthMm })} />
            </Grid>
          ) : null}
          {element.kind === "rect" ? <NumberField label="Corner radius" suffix="mm" value={element.radiusMm} min={0} max={150} onChange={(radiusMm) => onChange({ radiusMm })} /> : null}
        </>
      ) : null}
      {element.kind === "line" ? (
        <>
          <Grid>
            <ColourField label="Colour" value={element.color} onChange={(color) => onChange({ color })} />
            <NumberField label="Thickness" suffix="mm" value={element.strokeWidthMm} step={0.1} min={0.1} max={20} onChange={(strokeWidthMm) => onChange({ strokeWidthMm })} />
          </Grid>
          <CheckboxField checked={Boolean(element.dashed)} onCheckedChange={(checked) => onChange({ dashed: checked === true || undefined })} label="Dashed (a tear line)" />
        </>
      ) : null}
      {element.kind === "image" ? (
        <>
          <Grid>
            <Field label="Fit">
              <Dropdown value={element.fit} onChange={(event) => onChange({ fit: event.target.value as "contain" | "cover" })}>
                <option value="contain">Fit inside</option><option value="cover">Fill and crop</option>
              </Dropdown>
            </Field>
            <NumberField label="Corner radius" suffix="mm" value={element.radiusMm} min={0} max={150} onChange={(radiusMm) => onChange({ radiusMm })} />
          </Grid>
          <button type="button" className="self-start text-body-ui font-semibold text-ink underline underline-offset-4" onClick={onReplaceImage}>Replace image…</button>
        </>
      ) : null}
      {qr ? <p className="text-caption text-ink-muted">This is the ticket&apos;s check-in code. It&apos;s printed black on white, upright and solid so it scans; you can move and resize it.</p> : null}
    </div>
  );
}
