"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/choice";
import { Callout } from "@/components/ui/display";
import { Dropdown, Field, Input } from "@/components/ui/field";
import {
  ID_CARD_GRID_SIZES_MM,
  ID_CARD_TEAM_MERGE_FIELD,
  isDefaultLayout,
  layoutFlags,
  layoutForPaper,
  type IdCardLayoutElement,
  type IdCardLayoutFlags,
  type IdCardPrintSettings,
} from "@/lib/idCardPrint";
import type { BadgeBranding } from "@/lib/badge/types";
import { BadgeCanvas, BadgeFontFaces, elementHeightForMove } from "./BadgeCanvas";
import { printCard } from "./printCards";
import {
  SAFE_MARGIN_MM,
  sampleAttendee,
  type BadgeDesignSource,
  type IdCardAttendee,
  type RegistrationField,
  useIdCardSettings,
} from "./shared";
import { FitArea, SaveStatusPill, Section, SwitchLine, ToggleField } from "./IdCardDesigner/controls";
import { AnswersSection, ColourSection, LogosSection, PaperSection } from "./IdCardDesigner/sections";
import { DesignFileButtons } from "./IdCardDesigner/DesignFileButtons";
import { Inspector } from "./IdCardDesigner/Inspector";
import { StyleSection } from "./IdCardDesigner/StyleSection";
import { HelpLink } from "@/components/help/HelpLink";

export { FitArea, NumberSlider, SaveStatusPill, Section, SwatchGroup, SwitchLine, ToggleField } from "./IdCardDesigner/controls";
export { ColourSection, PaperSection } from "./IdCardDesigner/sections";
export { Inspector } from "./IdCardDesigner/Inspector";

type Sample = "short" | "long" | "attendee";

/**
 * Badge designer: style, colour, logos and content on the left, the card
 * drawn to scale in the middle, and the selected item's properties on the
 * right. The design saves to the event as you go, for every check-in desk.
 */
export function IdCardDesigner({
  source,
  branding,
  attendee,
  registrationFields,
  teamEvent = false,
  onClose,
}: {
  source: BadgeDesignSource;
  branding: BadgeBranding;
  attendee: IdCardAttendee | null;
  registrationFields: RegistrationField[];
  /** TEAM event: offers the Team line and the {{team}} merge field. */
  teamEvent?: boolean;
  onClose: () => void;
}) {
  const { settings, update, checkpoint, undo, redo, retry, canUndo, canRedo, status, error } = useIdCardSettings(source);
  const [selected, setSelected] = useState<IdCardLayoutElement>("name");
  const [sample, setSample] = useState<Sample>(attendee ? "attendee" : "short");
  const [guides, setGuides] = useState(true);
  const [notice, setNotice] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [printing, setPrinting] = useState(false);

  const previewPerson = sample === "attendee" && attendee ? attendee : sampleAttendee(registrationFields, sample === "long", teamEvent);

  // Undo/redo from the keyboard while the designer is open (not while typing).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const move = (element: IdCardLayoutElement, xMm: number, yMm: number) => {
    const size = settings.elementSizes[element];
    const height = elementHeightForMove(settings, element);
    const snap = (value: number) => Math.round(value / settings.gridSizeMm) * settings.gridSizeMm;
    const next = {
      xMm: Math.min(Math.max(0, settings.widthMm - size - SAFE_MARGIN_MM), Math.max(0, snap(xMm))),
      yMm: Math.min(Math.max(0, settings.heightMm - height - SAFE_MARGIN_MM), Math.max(0, snap(yMm))),
    };
    const current = settings.elementPositions[element];
    if (current.xMm === next.xMm && current.yMm === next.yMm) return;
    update({ elementPositions: { ...settings.elementPositions, [element]: next } }, false);
  };

  const flags = layoutFlags(settings);
  const setPaper = (widthMm: number, heightMm: number) => {
    update({ widthMm, heightMm, ...layoutForPaper(settings.template, widthMm, heightMm, flags) });
  };

  /**
   * Turn an optional item on or off. An untouched layout reflows so the new
   * item has room; a hand-adjusted one keeps every position.
   */
  const toggleItem = (flag: keyof IdCardLayoutFlags, on: boolean, element: IdCardLayoutElement) => {
    const nextFlags = { ...flags, [flag]: on };
    if (isDefaultLayout(settings, flags)) {
      update({ [flag]: on, ...layoutForPaper(settings.template, settings.widthMm, settings.heightMm, nextFlags) });
    } else {
      update({ [flag]: on });
    }
    if (on) setSelected(element);
  };

  const runPrint = async (person: IdCardAttendee) => {
    setPrinting(true);
    setNotice(null);
    try {
      const ok = await printCard({ settings, attendee: person, branding });
      if (!ok) setNotice({ tone: "danger", text: "The print window was blocked. Allow pop-ups for this site and try again." });
    } catch {
      setNotice({ tone: "danger", text: "The card couldn't be prepared. Try again." });
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BadgeFontFaces />
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 id="id-card-designer-title" className="text-h4 text-ink">Badge designer</h2>
          <p className="truncate text-caption text-ink-muted">{source.eventTitle} · every check-in desk prints this design</p>
        </div>
        <HelpLink article="check-in/badges" />
        <div className="flex items-center gap-2" aria-live="polite">
          <SaveStatusPill status={status} />
          {status === "error" ? <Button size="sm" variant="secondary" onClick={retry}>Try again</Button> : null}
        </div>
        <Button size="sm" variant="quiet" disabled={!canUndo} onClick={undo}>Undo</Button>
        <Button size="sm" variant="quiet" disabled={!canRedo} onClick={redo}>Redo</Button>
        <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
      </header>
      {status === "error" && error ? (
        <div className="px-4 pt-2"><Callout tone="danger" role="alert">{error} Your changes are kept on this device.</Callout></div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:grid lg:grid-cols-[300px_minmax(0,1fr)_272px] lg:overflow-hidden">
        {/* Settings */}
        <aside aria-label="Badge settings" className="order-2 flex shrink-0 flex-col gap-6 border-line p-4 sm:p-5 lg:order-none lg:overflow-y-auto lg:border-r">
          <StyleSection settings={settings} flags={flags} update={update} />

          <ColourSection settings={settings} branding={branding} update={update} />

          <PaperSection settings={settings} onPaper={setPaper} onCustom={(patch) => update(patch)} />

          <Section title="Text">
            <Field label="Heading">
              <Input maxLength={120} value={settings.heading} onChange={(event) => update({ heading: event.target.value })} />
            </Field>
            <ToggleField label="Badge label" checked={settings.showBadgeLabel} onCheckedChange={(showBadgeLabel) => update({ showBadgeLabel })}>
              <Input maxLength={40} value={settings.badgeLabel} disabled={!settings.showBadgeLabel} onChange={(event) => update({ badgeLabel: event.target.value })} placeholder="ATTENDEE" />
            </ToggleField>
            <ToggleField label="Footer" checked={settings.showFooter} onCheckedChange={(showFooter) => update({ showFooter })}>
              <Input maxLength={80} value={settings.footerText} disabled={!settings.showFooter} onChange={(event) => update({ footerText: event.target.value })} />
            </ToggleField>
            {teamEvent ? (
              <p className="text-caption text-ink-muted">
                Type <code className="rounded bg-subtle px-1 font-mono text-[12px] text-ink">{ID_CARD_TEAM_MERGE_FIELD}</code> in any of these to print the attendee&apos;s team name.
              </p>
            ) : null}
          </Section>

          <LogosSection settings={settings} branding={branding} update={update} toggleItem={toggleItem} />

          <Section title="Show on the badge">
            <SwitchLine
              label="Attendee photo"
              hint="Their uploaded profile photo, or their initials."
              checked={settings.showPhoto}
              onCheckedChange={(on) => toggleItem("showPhoto", on, "photo")}
            />
            {settings.showPhoto ? (
              <SegmentedControl<IdCardPrintSettings["photoShape"]>
                ariaLabel="Photo shape"
                size="sm"
                value={settings.photoShape}
                onValueChange={(photoShape) => update({ photoShape })}
                options={[{ value: "circle", label: "Circle" }, { value: "rounded", label: "Rounded square" }]}
                className="self-start"
              />
            ) : null}
            <SwitchLine label="Attendee email" checked={settings.showEmail} onCheckedChange={(showEmail) => update({ showEmail })} />
            <SwitchLine label="Shrink long names to fit" hint="Keeps names on one line, down to 60% of the size." checked={settings.nameAutoFit} onCheckedChange={(nameAutoFit) => update({ nameAutoFit })} />
          </Section>

          <AnswersSection settings={settings} fields={registrationFields} teamEvent={teamEvent} update={update} />
        </aside>

        {/* Canvas */}
        <section aria-label="Badge preview" className="order-1 flex min-h-[420px] min-w-0 shrink-0 flex-col bg-subtle lg:order-none lg:min-h-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-canvas px-3 py-2">
            <SegmentedControl<Sample>
              ariaLabel="Preview with"
              size="sm"
              value={sample}
              onValueChange={setSample}
              options={[
                { value: "short", label: "Short name" },
                { value: "long", label: "Long name" },
                ...(attendee ? [{ value: "attendee" as const, label: attendee.displayName.split(" ")[0] || "Attendee" }] : []),
              ]}
            />
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant={guides ? "secondary" : "quiet"} aria-pressed={guides} onClick={() => setGuides(!guides)}>
                {guides ? "Hide guides" : "Show guides"}
              </Button>
              <Dropdown aria-label="Snap to" value={String(settings.gridSizeMm)} onChange={(event) => update({ gridSizeMm: Number(event.target.value) as IdCardPrintSettings["gridSizeMm"] }, false)} className="w-[132px] text-[13px]">
                {ID_CARD_GRID_SIZES_MM.map((size) => <option key={size} value={size}>Snap {size} mm</option>)}
              </Dropdown>
            </div>
          </div>
          <FitArea widthMm={settings.widthMm} heightMm={settings.heightMm}>
            {(pxPerMm) => (
              <BadgeCanvas
                settings={settings}
                attendee={previewPerson}
                branding={branding}
                pxPerMm={pxPerMm}
                interaction={guides ? { selected, onSelect: setSelected, onBeginChange: checkpoint, onMove: move, showGrid: settings.showGrid } : undefined}
              />
            )}
          </FitArea>
          <p className="border-t border-line bg-canvas px-4 py-2 text-caption text-ink-muted">
            {guides ? "Click an item to edit it. Drag, or use arrow keys (Shift for bigger steps)." : "This is how the card prints. Guides never print."}
          </p>
        </section>

        {/* Inspector */}
        <aside aria-label="Selected item" className="order-1 shrink-0 border-line p-4 sm:p-5 lg:order-none lg:overflow-y-auto lg:border-l">
          <Inspector settings={settings} branding={branding} selected={selected} onSelect={setSelected} update={update} />
        </aside>
      </div>

      {notice ? (
        <div className="px-4 pt-2">
          <Callout tone={notice.tone} role={notice.tone === "danger" ? "alert" : "status"} action={<Button size="sm" variant="quiet" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice.text}</Callout>
        </div>
      ) : null}

      <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 sm:px-5">
        <DesignFileButtons
          settings={settings}
          eventTitle={source.eventTitle}
          organisationName={source.organisationName}
          onImport={(next) => {
            update(next);
            setNotice({ tone: "success", text: "Design imported." });
          }}
          onError={(text) => setNotice({ tone: "danger", text })}
        />
        <span className="hidden text-caption text-ink-muted md:inline">Print at 100% (actual size), no headers or footers.</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="secondary" disabled={printing} onClick={() => runPrint(sampleAttendee(registrationFields, false, teamEvent))}>
            Print test card
          </Button>
          {attendee ? (
            <Button variant="primary" disabled={printing} onClick={() => runPrint(attendee)}>
              Print {attendee.displayName.split(" ")[0]}&apos;s badge
            </Button>
          ) : (
            <Button variant="primary" onClick={onClose}>Done</Button>
          )}
        </div>
      </footer>
    </div>
  );
}
