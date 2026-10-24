"use client";

import { useState } from "react";
import { SegmentedControl } from "@/components/ui/choice";
import { Callout } from "@/components/ui/display";
import { Dropdown, Field, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import {
  ID_CARD_PAPER_PRESETS,
  ID_CARD_TEAM_FIELD_KEY,
  matchPaperPreset,
  SPONSOR_LIMIT_MAX,
  type IdCardLayoutElement,
  type IdCardLayoutFlags,
  type IdCardPrintSettings,
} from "@/lib/idCardPrint";
import {
  BADGE_ACCENT_KEYS,
  BADGE_BACKGROUND_KEYS,
  BADGE_TEXT_KEYS,
  BRAND,
  eventAccentHex,
  resolveBadgePalette,
} from "@/lib/badge/palette";
import type { BadgeBranding } from "@/lib/badge/types";
import { registrationFieldKey, type RegistrationField } from "../shared";
import { Section, SwatchGroup, SwitchLine } from "./controls";

export function ColourSection({ settings, branding, update }: { settings: IdCardPrintSettings; branding: BadgeBranding; update: (patch: Partial<IdCardPrintSettings>) => void }) {
  const eventColour = eventAccentHex(branding.eventAccent);
  const colourOf = (key: string) => (key === "event" ? eventColour : key === "auto" ? null : BRAND[key as keyof typeof BRAND]);
  const palette = resolveBadgePalette(settings, branding.eventAccent);
  const autoName = palette.text === BRAND.ink ? "Deep Ink" : palette.text === BRAND.cream ? "Warm Cream" : "White";
  return (
    <Section title="Colour">
      <SegmentedControl<IdCardPrintSettings["colorMode"]>
        ariaLabel="Colour mode"
        size="sm"
        value={settings.colorMode}
        onValueChange={(colorMode) => update({ colorMode })}
        options={[{ value: "colour", label: "Colour" }, { value: "mono", label: "Black and white" }]}
        className="self-start"
      />
      {settings.colorMode === "mono" ? (
        <p className="text-caption text-ink-muted">Print economy: black on white only, for laser and thermal printers. Logos and photos print in grey.</p>
      ) : (
        <>
          <SwatchGroup label="Card" value={settings.backgroundColor} options={BADGE_BACKGROUND_KEYS} colourOf={colourOf} onChange={(backgroundColor) => update({ backgroundColor })} />
          <SwatchGroup label={settings.template === "bold" ? "Band and accents" : "Frame and accents"} value={settings.accentColor} options={BADGE_ACCENT_KEYS} colourOf={colourOf} onChange={(accentColor) => update({ accentColor })} />
          <SwatchGroup label="Text" value={settings.textColor} options={BADGE_TEXT_KEYS} colourOf={colourOf} onChange={(textColor) => update({ textColor })} />
          {palette.textAdjusted ? (
            <Callout tone="warning">That text colour doesn&apos;t have enough contrast on this card, so text prints in {autoName}.</Callout>
          ) : null}
          <p className="text-caption text-ink-muted">Text always keeps a 4.5:1 contrast with what it sits on. Event accent: {eventColour}.</p>
        </>
      )}
    </Section>
  );
}

export function PaperSection({
  settings,
  onPaper,
  onCustom,
}: {
  settings: IdCardPrintSettings;
  onPaper: (widthMm: number, heightMm: number) => void;
  onCustom: (patch: Partial<IdCardPrintSettings>) => void;
}) {
  const match = matchPaperPreset(settings.widthMm, settings.heightMm);
  const [custom, setCustom] = useState(!match);
  const landscape = settings.widthMm > settings.heightMm;
  const presetId = custom ? "custom" : match?.preset.id ?? "custom";
  return (
    <Section title="Paper">
      <Field label="Badge stock" helperText={custom ? "Enter your stock's size. Positions keep where they are." : match?.preset.detail}>
        <Dropdown
          value={presetId}
          onChange={(event) => {
            const preset = ID_CARD_PAPER_PRESETS.find((item) => item.id === event.target.value);
            if (!preset) return setCustom(true);
            setCustom(false);
            const [w, h] = landscape !== preset.widthMm > preset.heightMm ? [preset.heightMm, preset.widthMm] : [preset.widthMm, preset.heightMm];
            onPaper(w, h);
          }}
        >
          {ID_CARD_PAPER_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          <option value="custom">Custom size</option>
        </Dropdown>
      </Field>
      {custom ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Width (mm)"><Input type="number" min={40} max={300} step={0.1} value={settings.widthMm} onChange={(event) => onCustom({ widthMm: Number(event.target.value) })} /></Field>
          <Field label="Height (mm)"><Input type="number" min={40} max={300} step={0.1} value={settings.heightMm} onChange={(event) => onCustom({ heightMm: Number(event.target.value) })} /></Field>
        </div>
      ) : null}
      <SegmentedControl<"portrait" | "landscape">
        ariaLabel="Orientation"
        size="sm"
        value={landscape ? "landscape" : "portrait"}
        onValueChange={(next) => {
          if ((next === "landscape") !== landscape) onPaper(settings.heightMm, settings.widthMm);
        }}
        options={[{ value: "portrait", label: "Portrait" }, { value: "landscape", label: "Landscape" }]}
        className="self-start"
      />
    </Section>
  );
}

export function AnswersSection({ settings, fields, teamEvent, update }: { settings: IdCardPrintSettings; fields: RegistrationField[]; teamEvent: boolean; update: (patch: Partial<IdCardPrintSettings>) => void }) {
  const options = [
    ...(teamEvent ? [{ key: ID_CARD_TEAM_FIELD_KEY, label: "Team" }] : []),
    ...fields.map((field) => ({ key: registrationFieldKey(field.key), label: field.label })),
  ];
  const chosen = settings.printFieldKeys.flatMap((key) => options.find((option) => option.key === key) ?? []);
  const available = options.filter((option) => !settings.printFieldKeys.includes(option.key));
  const moveField = (index: number, by: -1 | 1) => {
    const keys = [...settings.printFieldKeys];
    const [item] = keys.splice(index, 1);
    keys.splice(index + by, 0, item!);
    update({ printFieldKeys: keys });
  };
  return (
    <Section title="Registration answers">
      {options.length === 0 ? (
        <p className="text-caption text-ink-muted">This event&apos;s sign-up form has no extra questions to print.</p>
      ) : (
        <>
          {chosen.length > 0 ? (
            <ol className="flex flex-col gap-2">
              {chosen.map((field, index) => (
                <li key={field.key} className="flex flex-col gap-2 rounded-[10px] border border-line p-2.5">
                  <span className="min-w-0 truncate text-label text-ink">{field.label}</span>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="quiet" aria-label={`Move ${field.label} up`} disabled={index === 0} onClick={() => moveField(index, -1)}>Up</Button>
                    <Button size="sm" variant="quiet" aria-label={`Move ${field.label} down`} disabled={index === chosen.length - 1} onClick={() => moveField(index, 1)}>Down</Button>
                    <Button size="sm" variant="quiet" aria-label={`Remove ${field.label}`} onClick={() => update({ printFieldKeys: settings.printFieldKeys.filter((key) => key !== field.key) })}>Remove</Button>
                  </div>
                  <Input
                    aria-label={`Printed label for ${field.label}`}
                    maxLength={60}
                    value={settings.printFieldLabels[field.key] ?? field.label}
                    placeholder="No label, just the answer"
                    onChange={(event) => update({ printFieldLabels: { ...settings.printFieldLabels, [field.key]: event.target.value } })}
                  />
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-caption text-ink-muted">Print answers like company or role under the name.</p>
          )}
          {available.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Add an answer">
              {available.map((field) => (
                <button
                  key={field.key}
                  type="button"
                  onClick={() => update({ printFieldKeys: [...settings.printFieldKeys, field.key] })}
                  className="inline-flex min-h-9 items-center rounded-full border border-dashed border-line-strong px-3 text-[13px] font-semibold text-ink-secondary hover:bg-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  Add {field.label}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </Section>
  );
}

export function LogosSection({
  settings,
  branding,
  update,
  toggleItem,
}: {
  settings: IdCardPrintSettings;
  branding: BadgeBranding;
  update: (patch: Partial<IdCardPrintSettings>) => void;
  toggleItem: (flag: keyof IdCardLayoutFlags, on: boolean, element: IdCardLayoutElement) => void;
}) {
  return (
    <Section title="Logos">
      <SwitchLine
        label="Space Works symbol"
        hint="Placed unaltered, with clear space around it."
        checked={settings.showSymbol}
        onCheckedChange={(on) => toggleItem("showSymbol", on, "symbol")}
      />
      <SwitchLine
        label="Organisation logo"
        hint={branding.organisationLogoUrl ? undefined : "Add a logo in organisation settings first."}
        disabled={!branding.organisationLogoUrl}
        checked={settings.showLogo && Boolean(branding.organisationLogoUrl)}
        onCheckedChange={(on) => toggleItem("showLogo", on, "logo")}
      />
      <SwitchLine
        label="Event logo"
        hint={branding.eventLogoUrl ? undefined : "Add a logo to the event website first."}
        disabled={!branding.eventLogoUrl}
        checked={settings.showEventLogo && Boolean(branding.eventLogoUrl)}
        onCheckedChange={(on) => toggleItem("showEventLogo", on, "eventLogo")}
      />
      <SwitchLine
        label="Sponsor logos"
        hint={branding.sponsorLogoUrls.length ? `${branding.sponsorLogoUrls.length} published sponsor${branding.sponsorLogoUrls.length === 1 ? "" : "s"} with a logo.` : "Publish sponsors with logos on the event website first."}
        disabled={branding.sponsorLogoUrls.length === 0}
        checked={settings.showSponsors && branding.sponsorLogoUrls.length > 0}
        onCheckedChange={(on) => toggleItem("showSponsors", on, "sponsors")}
      />
      {settings.showSponsors && branding.sponsorLogoUrls.length > 1 ? (
        <Field label="Sponsors on each badge">
          <Dropdown value={String(Math.min(settings.sponsorLimit, branding.sponsorLogoUrls.length))} onChange={(event) => update({ sponsorLimit: Number(event.target.value) })}>
            {Array.from({ length: Math.min(SPONSOR_LIMIT_MAX, branding.sponsorLogoUrls.length) }, (_, index) => index + 1).map((count) => (
              <option key={count} value={count}>Up to {count}</option>
            ))}
          </Dropdown>
        </Field>
      ) : null}
    </Section>
  );
}
