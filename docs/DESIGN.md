# Space Works Events design system — agent brief

> Read this before building or changing any Space Works Events UI. It describes how the brand is
> implemented in this app.
>
> **Source of truth for the brand:** [SpaceWorks-Labs/SpaceWorks-Design](https://github.com/SpaceWorks-Labs/SpaceWorks-Design):
> `tokens/tokens.css` (colour values), `docs/ui-brand-spec.md` (tokens, states, type, shape, logo, icons),
> `logo/` (master artwork), `fonts/` (Gilroy, Unbounded and their licences). When this file and the
> design repo disagree, the design repo wins. Update this file to match.
>
> The app was forked from Yuyu (github.com/twilighty-abhi/yuyu). The `--yy-*` variable prefix and the
> `yy-*` helper classes (`yy-accent-scope`, `yy-dark-band`, `ease-yy`) are kept from that code base so
> existing utilities keep working. Their **values** are Space Works.

---

## 1. What the design must do

Space Works Events is a self-hosted platform for running community events, free by default, with
optional tickets paid straight to the organiser's own Razorpay or Stripe account (no platform fee, no ad
trackers). Most organisers are volunteers and small groups. Most attendees open an event link on a
phone.

1. **Calm in the product, warm in public.** Dashboards are quiet cream, white panels and hairlines.
   Public pages may have one bold moment.
2. **The event leads.** On event-facing pages the organiser's accent colour, cover and logo carry the
   identity. Space Works chrome stays neutral.
3. **One bold moment per layout.** Workshop Orange appears once, as a fill with an ink label, never as text.
4. **Simple for volunteers.** One obvious primary action per view. Destructive actions look different and
   confirm before acting.
5. **Accessible by default.** WCAG AA contrast for every token pair, real form controls, 44px targets,
   keyboard reachable, works at 360px wide.

---

## 2. Design tokens

Every value lives in `app/styles/tokens.css` and is mapped to Tailwind utilities in `app/globals.css`
(§9.1). **Never hard-code a hex in a component.** Use a token or a raw brand utility (`bg-sw-citron`).

### 2.1 Brand colours

Seven colours, plus the Yuyu reds for danger (the brand has no red). No black, no other hues.

| Name | Hex | Utility | Role |
|---|---|---|---|
| Deep Ink | `#142C2A` | `sw-ink` | Text, inverse surfaces, dark-mode ground |
| Maker Teal | `#006E63` | `sw-teal` | Primary actions, links, focus (light) |
| Workshop Orange | `#FF7447` | `sw-orange` | Emphasis fill with an ink label. Never text. |
| Citron | `#DFFF8F` | `sw-citron` | Success, dashboard sidebar, focus (dark), selection |
| Sky Blue | `#B5CDFF` | `sw-sky` | Info |
| Warm Yellow | `#FFD447` | `sw-yellow` | Warning |
| Warm Cream | `#FFF4E8` | `sw-cream` | Page ground, labels on teal |
| Danger reds | `#B91C1C`, `#991B1B`, `#FCA5A5` | `danger-*` | Destructive actions and errors |

Brand-tested pairs: cream on teal 5.68, ink on cream 13.60, ink on orange 5.51, ink on yellow 10.37,
ink on citron 13.23, ink on sky 9.23. Orange on cream is 2.47, which is why orange is never text.

### 2.2 Neutrals and surfaces

Light mode is a Warm Cream page with white panels. Dark mode is the brand's teal-lit Deep Ink.

| Token (`--yy-…`) | Utility | Light | Dark | Use |
|---|---|---|---|---|
| `bg-canvas` | `bg-canvas` | `#FFF4E8` | `#142C2A` | Page background |
| `bg-panel` | `bg-panel` | `#FFFFFF` | `#1F433F` | Cards, panels, inputs, dialogs, menus |
| `bg-surface` | `bg-surface` | `#F6ECE0` | `#193935` | Recessed areas, table headers, disabled fills |
| `bg-subtle` | `bg-subtle` | `#F6ECE0` | `#193935` | Hover on cards and rows |
| `bg-muted` | `bg-muted` | `#EFE6DB` | `#254D48` | Hover on controls, neutral fills |
| `bg-emphasis` | `bg-emphasis` | `#EAE2D7` | `#2B5751` | Pressed controls, selected neutral fills |
| `bg-track` | `bg-track` | `#EAE2D7` | `#2B5751` | Progress-bar tracks |
| `border` | `border-line` | `#D5D0C6` | `#4D6D67` | Hairlines on cards and dividers |
| `border-strong` | `border-line-strong` | `#828A83` | `#93A198` | Form-control outline (≥3:1) |
| `text` | `text-ink` | `#142C2A` | `#FFF4E8` | Primary text |
| `text-secondary` | `text-ink-secondary` | `#374A47` | `#E3DCD1` | Body copy under headings |
| `text-muted` | `text-ink-muted` | `#5B6863` | `#C7C4BA` | Meta, captions, helper text, placeholders |
| `text-disabled` | `text-ink-disabled` | `#828A83` | `#93A198` | Disabled labels only (WCAG-exempt) |

### 2.3 Actions, emphasis and chrome

| Token | Utility | Light | Dark | Use |
|---|---|---|---|---|
| `primary` / `-hover` / `-active` | `bg-primary` … | `#006E63` / `#02675D` / `#046158` | same | Space Works' own primary action |
| `on-primary` | `text-on-primary` | `#FFF4E8` | `#FFF4E8` | Label on teal (5.68) |
| `inverse-surface` | `bg-inverse` | `#142C2A` | `#254D48` | Toasts, tooltips, code blocks, sticky bars |
| `on-inverse` | `text-on-inverse` | `#FFF4E8` | `#FFF4E8` | |
| `highlight` / `-hover` | `bg-highlight` | `#FF7447` / `#FF8157` | same | The one bold moment: public CTA, counters, "2 left" |
| `on-highlight` | `text-on-highlight` | `#142C2A` | `#142C2A` | Ink on orange (5.51) |
| `highlight-soft` | `bg-highlight-soft` | `#FFEEE9` | `#2F4640` | Warm tinted panels |
| `sidebar` | `bg-sidebar` | `#DFFF8F` | `#113532` | Dashboard sidebar field |
| `sidebar-hover` | `bg-sidebar-hover` | `#F2FFD2` | `#254D48` | Sidebar item hover |
| `sidebar-active` | `bg-sidebar-active` | `#006E63` | `#006E63` | Current sidebar item |
| `on-sidebar-active` | `text-on-sidebar-active` | `#FFF4E8` | `#FFF4E8` | |
| `focus` | (ring) | `#006E63` | `#DFFF8F` | Focus ring; event pages use the accent text colour |

Legacy names keep working and now point at brand colours: `brand-marigold*` → Workshop Orange,
`brand-dot-base` → ink/cream, `brand-dot-off` → line, `highlight-peach` → Citron (light) / `#2F4640`
(dark, used for selection and the `.yy-highlight` marker), `tint-peach` → `highlight-soft`.

### 2.4 Status

Status always pairs colour with a **word** (mandatory) and optionally an icon. Light mode uses the
brand's solid pastels with ink words; dark mode uses soft fills with the brand colour as the word.

| Status | `*-bg` (L / D) | `*-fg` (L / D) | `*-solid` (L / D) | Used for |
|---|---|---|---|---|
| Success (Citron) | `#DFFF8F` / `#2C5045` | `#536D49` / `#DFFF8F` | `#536D49` / `#DFFF8F` | Going, Published, Checked in |
| Warning (Warm Yellow) | `#FFD447` / `#2F4D40` | `#142C2A` / `#FFD447` | `#696834` / `#FFD447` | Waitlist, Pending approval, Draft reminders |
| Info (Sky Blue) | `#B5CDFF` / `#2A4D4C` | `#142C2A` / `#B5CDFF` | `#51697B` / `#B5CDFF` | Completed, waitlisted, neutral notices |
| Danger (Yuyu reds) | `#F7E4E4` / `#3A4F4B` | `#B91C1C` / `#FCA5A5` | `#B91C1C` / `#FCA5A5` | Delete, invalid ticket, errors |
| Danger border | `#FCA5A5` / `#7C6261` | | | Danger-zone card outline |
| Danger hover / on-danger | `#991B1B` / `#FDB9B6` · `#FFF4E8` / `#142C2A` | | | Solid danger button |

`*-solid` is for dots, bars and icons that must stand out on the page (≥3:1 on canvas). It is a dark
brand-mix in light mode and the brand fill in dark mode, so put text on a solid fill only with the
matching label: `text-on-success`, `text-on-warning`, `text-on-info`, `text-on-danger` (cream in light,
Deep Ink in dark). Never `text-white` on a status solid.
Attention counters use `bg-highlight text-on-highlight`, not danger.

### 2.5 Colour — event accent (organiser theming)

Every event and organisation can have an accent colour (`Event.accentColor`). The default is **Maker
Teal `#006E63`**; organisation pages, instance pages and tickets without one fall back to **Deep Ink
`#142C2A`** (`INK_ACCENT`). On event-facing pages the accent drives the title, the Register button, the
date-block header, progress fills, the active section underline and accent chips.

`lib/theme/accent.ts` derives the tokens and the page root sets them inline (`accentStyle()` plus the
`yy-accent-scope` class, which picks the light or dark set):

| Token | Formula |
|---|---|
| `--yy-accent` | organiser value (validated `#RRGGBB`) |
| `--yy-accent-soft` | white panel + 12 % accent (light); dark panel `#1F433F` + 16 % accent (dark) |
| `--yy-on-accent` | first of cream, Deep Ink, white, black that reaches 4.5:1 on the accent |
| `--yy-accent-text` | light: the accent, darkened toward Deep Ink until ≥4.5 on canvas, panel, surface and soft. Dark: 33 % accent in cream, lightened until it passes the same check on the dark surfaces |

With the default teal these reproduce the global tokens exactly (`#E0EEEC`, `#FFF4E8`, `#006E63`; dark
`#1A4A45`, `#ABC8BC`), so an event in the default colour looks like the rest of the product.

Preset swatches (`ACCENT_PRESETS`; the `name` values are stable keys for swatch artwork):

| Key | Colour | Label on fill |
|---|---|---|
| Teal (default) | Maker Teal `#006E63` | cream |
| Ember | Workshop Orange `#FF7447` | Deep Ink |
| Iris | Sky Blue `#B5CDFF` | Deep Ink |
| Ink | Deep Ink `#142C2A` | cream |

Space Works chrome (dashboard shell, marketing pages, auth) never uses an event accent. In the dashboard
an event's accent appears only on its own date block and progress bar.

### 2.6 Typography

| Role | Family | Weights | Files |
|---|---|---|---|
| Headings, titles, numbers | **Gilroy** | 600 (700 for inline strong) | `public/brand/fonts/Gilroy-SemiBold.woff`, `Gilroy-Bold.woff` |
| Body, labels, controls, IDs | **Gilroy** | 400, 500, 600, 700 | `Gilroy-Regular.woff`, `Gilroy-Medium.woff` + above |
| One short expressive accent | **Unbounded** | 500 (600 allowed) | `Unbounded-Variable.woff2` |
| Code, secrets, JSON | system monospace | — | none (`--font-mono`) |

Fonts are self-hosted with `@font-face` in `app/globals.css` (privacy invariant: no font CDNs).
Licences are in `public/brand/fonts/LICENSES/`. `font-synthesis: none` is set on `body`: there is no
faux bold or italic. Gilroy Bold also answers legacy 800/900 requests.

- `font-sans` and `font-display` are Gilroy. Headings are **600, never 800**.
- `font-accent` is Unbounded 500 with −0.01em tracking: **one short phrase per public layout** (landing
  hero, auth brand panel, an empty-state hero). Never in dashboard or staff chrome.
- IDs, codes and counts use Gilroy 500 with `tabular-nums`, not a monospace face.

Type scale (mobile → desktop from 640px):

| Class | Weight | Size / line | Tracking | Use |
|---|---|---|---|---|
| `text-display-xl` | 600 | 44/48 → 72/76 | −0.02em | Landing hero |
| `text-display-l` | 600 | 40/43 → 64/68 | −0.02em | Event title, About/Features hero |
| `text-display-m` | 600 | 34/38 → 48/52 | −0.015em | Public page titles |
| `text-h1` | 600 | 26/32 → 32/38 | −0.01em | One page title per screen |
| `text-h2` | 600 | 22/28 → 28/34 | −0.01em | Event page sections |
| `text-h3` | 600 | 20/26 → 24/30 | −0.005em | Card and dialog titles |
| `text-h4` | 600 | 18/24 → 20/28 | −0.005em | Dashboard section titles |
| `text-title` | 600 | 16/24 | 0 | Card and list-row titles |
| `text-body-l` | 400 | 17 → 19 | 0 | Lead paragraphs |
| `text-body` | 400 | 16/24 | 0 | Default copy, inputs |
| `text-body-ui` | 400 | 15/22 | 0 | Dense dashboard copy |
| `text-label` | 500 | 14/20 | 0 | Form labels, nav, meta |
| `text-caption` | 500 | 13/18 | 0.01em | Helper text, timestamps |
| `text-overline` | 600 | 12/16 UPPERCASE | 0.08em | Eyebrows ("VENUE") |
| `font-accent` | Unbounded 500 | inherit | −0.01em | One accent phrase |

Button labels are Gilroy 600. Body copy max width ~640px.

### 2.7 Spacing

4px grid: `4, 8, 12, 16, 20, 24, 32, 40, 48, 64`. Page gutter 16 (mobile) / 24 / 32. Card padding 20
(24 on settings). Every control is 44px tall. Rows: 56 for lists, 48 for tables.

### 2.8 Radius

| Utility | px | Use |
|---|---|---|
| `rounded-sm` | 6 | Checkboxes, tiny controls |
| `rounded` | 8 | Inline elements |
| `rounded-md` / `rounded-control` | 10 | **Buttons**, inputs, selects, nav items, date block |
| `rounded-lg` | 12 | Menus, popovers, callouts, segmented track |
| `rounded-xl` | 16 | **Cards, panels, tables, dialogs** |
| `rounded-2xl` | 20 | Feature panels |
| `rounded-3xl` | 24 | Hero panels, ticket |
| `rounded-full` | 9999 | Status pills, filter chips, avatars, switches |

Prefer `rounded-md` over `rounded-control` inside `cn()`: `tailwind-merge` does not know the custom
`control` key, so a later `rounded-*` override would not replace it.

### 2.9 Elevation

**No shadows on cards.** Cards and panels use a 1px `border-line`.

| Token | Value | Use |
|---|---|---|
| `shadow-raised` | `none` | Legacy name for cards; now flat |
| `shadow-ticket` | `none` | Legacy ticket stub; `.yy-ticket-shadow` draws a hairline that follows the torn edge |
| `shadow-segment` | `0 0 0 1px var(--yy-border-strong)` | Segmented-control thumb and switch thumb outline |
| `shadow-float` | `0 2px 6px rgb(20 44 42 / .06), 0 12px 32px rgb(20 44 42 / .10)` | **Overlays only:** menus, popovers, dialogs, toasts, tooltips |

### 2.10 Motion

- Colour changes 120ms. Expand 200ms. Dialog enter 240ms, exit 160ms. Easing `ease-yy`
  (`cubic-bezier(.2,.8,.2,1)`).
- **No translate, scale or shadow on hover.** Buttons change colour only.
- Content is visible by default; scroll reveals only enhance.
- `prefers-reduced-motion: reduce` → no translate/scale, fades ≤ 120ms.
- Colour-mode switch (`components/providers.tsx`): the new mode grows from the toggle as a soft circle
  (View Transitions); without them colours cross-fade; reduced motion switches instantly.
- Restart-safe sequences: React runs effects twice in development. An imperative `animate()` sequence
  must check it is still the current run after each `await` (see `AGENTS.md`).

### 2.11 Breakpoints

`sm 640` · `md 960` · `lg 1200`. Mobile-first. Two-column layouts stack below `md`.

---

## 3. Logo, icons and imagery

### 3.1 Logo

Use the master artwork from SpaceWorks-Design `logo/` **unaltered** (no recolouring, stretching,
rotation, effects or re-typed wordmarks). Brand components live in `components/brand/`.

| Ground | Artwork |
|---|---|
| Warm Cream | Full colour (`lockup-*.svg`, `symbol.svg`) |
| White | One-colour Deep Ink (`*-one-colour-ink.svg`) |
| Deep Ink or Maker Teal (dark mode, dark bands) | Reversed cream (`*-reversed.svg`) |

- Clear space: ¼ of the symbol height on every side.
- Minimum sizes: symbol ≥ 48px; primary lockup ≥ 180px wide. Favicon and app icon are the only
  exceptions (they use `app-icon.svg`, rasterised).
- Placements: dashboard sidebar stacked lockup 180px wide; mobile top bar symbol 48px; public header
  horizontal lockup ≥ 768px, symbol below; auth brand panel stacked lockup 240–320px; social card cream
  1200×630 with the stacked lockup 600px wide.
- Copy: the product is **"Space Works Events"**, the organisation **"Space Works"**. "SpaceWorks"
  (no space) is for code identifiers, URLs and repo names only.

### 3.2 Icons

`lucide-react` (24px grid, 2px stroke, round caps), rendered at 16/18/20px. Decorative icons get
`aria-hidden`; icon-only buttons need `IconButton` with a required `label`. **The dashboard sidebar is
text-only.** Use icons only where they help: search, add, back, external link, switchers, callouts,
overflow, theme toggle, sign out.

### 3.3 Imagery

- No emoji in UI.
- Event cover: 16:7 on the event page, 2:1 on cards. With none, `.yy-cover-placeholder` draws the accent
  with a soft cream dot grid. Never a broken image.
- Avatars: photo, else 1–2 initials (Gilroy 600) on a tint. `AvatarImage` swaps to initials on error.
- Organisation logo: square; fallback is initials on teal.
- QR codes always sit on a white plate, in both modes.

---

## 4. Components (`components/ui/*`)

All primitives are Radix + Tailwind. Their props and exports are stable; prefer them over one-off markup.

### 4.1 Button

`rounded-md` (10px), Gilroy 600, `min-h-11` for every size (`lg` is 48px). No hover lift, scale or
shadow; colour changes only. Focus uses the global 2px ring with a 2px offset.

| Variant | Rest | Hover | When |
|---|---|---|---|
| `primary` | `bg-primary text-on-primary` | `bg-primary-hover` | One per view: Save, Create, Sign in |
| `accent` | `bg-accent text-on-accent` | accent mixed 12 % toward Deep Ink | Event-facing primary: Register |
| `secondary` / `neutral` | `bg-panel border-line text-ink` | `bg-muted` | Second action: Cancel, Share |
| `ghost` | `text-accent-text` | `bg-accent-soft` | Low-emphasis action in teal |
| `quiet` | `text-ink-secondary`, underline on hover | | Tertiary: Back, Undo |
| `highlight` | `bg-highlight text-on-highlight` | `bg-highlight-hover` | The one bold public CTA. Never in dashboard chrome |
| `danger` / `dangerOutline` | `bg-panel border-danger-fg text-danger-fg` | `bg-muted`, darker red | Opens a confirmation: Delete organisation… |
| `dangerSolid` | `bg-danger-solid text-on-danger` | `bg-danger-hover` | The final destructive confirm (used by `ConfirmDialog`) |
| `dangerQuiet` | `text-danger-fg` | underline | Revoke, Turn off station |
| `inverse` | `bg-on-inverse text-inverse` | `bg-subtle` | On dark bands |

**Disabled** is explicit, never opacity: `bg-surface text-ink-muted border-line`. Loading keeps the
width and swaps in a spinner. Destructive actions are never `primary`; triggers end with "…" and open
a dialog.

### 4.2 Text input / textarea / select

- Label above (`text-label`), never floating. Optional fields say "Optional" in muted text.
- Field (`controlClasses`): `bg-panel`, 1px `border-line-strong` (3:1), `rounded-md`, 44px tall, 16px text.
  Hover `border-ink`; focus `border-accent` + 2px focus ring; invalid (`aria-invalid`) `border-danger-fg`
  with a danger helper line and icon; disabled and read-only `bg-surface` + `border-line`.
- Placeholders use `text-ink-muted` (readable, not disabled grey).
- Prefix fields join a `bg-surface` segment to the input. Search has a leading icon and a clear button.
- Dropdowns never use the browser picker: `Dropdown` (`components/ui/select.tsx`) keeps a hidden native
  `<select>` for forms and renders a panel listbox with `shadow-float`.

### 4.3 Choice controls

- **Checkbox / radio:** 20px, `bg-panel`, outline border; checked = teal fill (checkbox) or teal dot.
- **Checkbox card / radio card:** `bg-panel`, 1px line; checked = 1.5px teal (or accent) border.
- **Switch:** outline-grey track, teal when on; white panel thumb with a 1px outline ring.
- **Segmented control:** `bg-surface` track with a hairline and 4px padding; selected segment
  `bg-panel` + outline ring, `rounded-md`.
- **Filter chip:** fully round; selected = teal fill with cream text; `aria-pressed`.
- **Colour picker** (`components/ui/color-picker.tsx`): presets (§2.5) then "Custom": saturation area,
  hue slider, hex box, eyedropper where supported, live Register/link sample using the same contrast rules.

### 4.4 Tabs & navigation

- Underline tabs: rest `text-ink-muted`, hover `text-ink`, active `text-ink` + **2px underline** (teal in
  the product, the event accent on event pages). Rows scroll sideways with faded arrow hints.
- Dashboard sidebar: Citron field (`bg-sidebar`), text-only items 44px tall, hover `bg-sidebar-hover`,
  current item `bg-sidebar-active text-on-sidebar-active font-semibold` with `aria-current="page"`.
  Dark mode uses the Deep Ink sidebar.
- Back link: `← All events`, quiet, 14px 600.

### 4.5 Status pills (`Chip`)

Fully round, 24px tall (`min-h-6`), 12–13px Gilroy 600, padding 8–10. **The word is mandatory**; the
icon is optional. Tones: `success`, `warning`, `info` (solid pastel + ink in light, soft + brand word in
dark), `danger` (panel + `danger-border` + red word), `accent` (accent-soft + accent text), `highlight`
(orange + ink; for "2 left"-style attention), `neutral` (surface + hairline + ink), `ink` (inverse),
`outline`.

Recurring events are "Series" in the dashboard and "Every Tuesday" / "Weekly" to attendees.

### 4.6 Date block

50–68px wide, `rounded-md`, 1px line, `bg-panel`. Top band: month, 11–12px 600, 0.08em tracking, on the
accent (event), teal (product) or `bg-emphasis` (draft). An explicit `color` gets its contrast-checked
label from `getAccentTokens`. Bottom: day in Gilroy 600 `tabular-nums`, 20–30px.

### 4.7 Cards

- **Base card** (`Card`): `bg-panel`, 1px `border-line`, `rounded-xl` (16px), padding 16–24, **no shadow**.
  Clickable cards are one `<a>` with hover `bg-subtle`.
- **Stat tile:** label (14px muted) over a Gilroy 600 `tabular-nums` number (32px); optional progress
  bar; "attention" variant on `bg-warning-bg`.
- **Callout:** tinted status fill (`warning`, `info`, `success`, `danger`), icon, bold first sentence,
  one action. One per page. No translucent text.
- **Empty state:** panel card, centred, says what to do next ("No guests yet. Share the event link to
  get sign-ups."). Space Works Events' own screens may add a `mood` illustration.
- **Danger zone:** `bg-panel` card with a 1px `border-danger-border`, title in `text-danger-fg`, a
  `danger` (outline) trigger that opens a `dangerSolid` confirmation.

### 4.8 Lists & tables

- `Table`: `rounded-xl` panel with a 1px line; header row on `bg-surface`, 14px Gilroy 600 sentence case
  in `text-accent-text`; **rows 48px** with 1px `border-line` separators; hover `bg-subtle`; scrolls
  inside its own box on small screens.
- Person cell = avatar + name + email (never repeat the email).
- Timestamps: relative for < 7 days ("2 min ago"), else "13 Oct 2026".

### 4.9 Schedule / programme

- Schedule list: time (600) + duration (muted) · title link + speakers · track chip (accent for the
  main track, neutral for others).
- Programme grid: time column + one column per track; sessions as tinted blocks; breaks span tracks.
- Live schedule: NOW card (accent fill, on-accent text, progress), NEXT card with delay chip, LATER list.

### 4.10 Event registration card

Right column on desktop (sticky), below the title on mobile plus a sticky bottom Register bar. States:
Open · Full ("Join the waitlist", warning) · Approval required · Closed (disabled + reason) ·
Registered ("You're in", success + View ticket).

### 4.11 Ticket

Phone-first. Stub card `rounded-3xl`, flat with a hairline: accent header, 2-column detail grid,
perforation, QR on a white plate. When the desk checks the guest in, the stub tears away
(`.yy-ripped-bottom` / `.yy-ripped-top`, paired with `.yy-ticket-shadow`) and a "You're checked in"
panel on `bg-success-bg` takes its place. Reduced motion: no rip, a 120ms fade.

### 4.12 Check-in

Station kiosk with a full-height result panel: success (success fill, "Checked in", name in display
type), waitlisted (warning), invalid (danger fill with `text-on-danger`, plain-language reason). Badge
printing and the badge designer live in `components/checkin/`. The desk's Recent check-ins show the
25 newest with **Load more** ("Showing x of N checked in"); its CSV button is the full attendee export
and shows only with export access.

### 4.13 App shell (dashboard)

Citron text-only sidebar (§4.4) with the stacked lockup at 180px, organisation switcher, and an account
menu (Account settings, Light/Dark mode, Sign out). Page title pattern: optional kicker (muted) + `h1` +
one-line description. Settings pages: label column / field column rows separated by hairlines.
Super-admin pages stay restrained: panel cards, metric rows, small charts, capped tables, no accents.

### 4.14 Public chrome

Site header with the horizontal lockup (symbol below 768px), Discover · Features · About, and Sign in
(secondary) + Start organising (primary, or `highlight` as the page's one bold moment). Event-context
pages show the **organiser** logo and name, with a small "Powered by Space Works Events" credit in the
footer. Auth pages: logo-only header, centred `rounded-xl` panel card, or a split layout with a cream
brand panel that may hold the one `font-accent` phrase.

### 4.15 Dialogs, toasts, menus

- Dialog: `bg-panel`, `rounded-xl`, 1px line, `shadow-float`, max 480px; title (`text-h3`) + body +
  actions right-aligned (secondary, then primary/`dangerSolid`). Overlay Deep Ink at 48 %.
- Review-before-send dialog for irreversible bulk actions (summary + "I've checked…" checkbox), then a 5s
  undo window.
- Toast: `bg-inverse text-on-inverse`, `shadow-float`, 4s, optional Undo.
- Menu / popover: `bg-panel`, `rounded-lg`, 1px line, `shadow-float`; items 40px, highlighted `bg-muted`,
  danger items last in `text-danger-fg`. Tooltip: `bg-inverse`, 13px.

### 4.16 Cover photo editor and account card

The cover picker, `PhotoEditor` (`components/media`) and `AccountCard` (`components/account`) follow the
card and dialog rules above: panel surfaces, hairlines, 16px radius, no shadows except on overlays.

---

## 5. Page patterns

- **Event page:** organiser header → cover (16:7) → two columns ≥ 960 (content left: title in accent
  display, date block + venue, section nav, About, Schedule, Speakers, Venue, FAQ; sticky registration
  card right). Mobile: title → registration card → sections + sticky Register bar.
- **Dashboard home:** greeting with one real-number sentence, a "Needs you" warning callout (managers
  only), Next up in its event accent, stats from real queries, Your events (Upcoming / Drafts / Past),
  Activity (names only, never emails), Organisations.
- **Organisation workspace:** banner, Needs you, Next up + mini calendar, stats, events list with search,
  series and team. Members see no management links.
- **Event dashboard tabs:** Overview, Guests, Event page (publishing questions, accent picker, cover
  editor, registration form), Emails, Check-in, Feedback, Analytics, Finance, Settings. A Judging tab
  (between Check-in and Feedback) appears only on events that use hackathon judging
  ([Hackathon](HACKATHON.md)); until then its on switch sits in Settings.
- **Guests lists are paged on the server**, never capped in the browser: People 50 at a time with
  **Load more**, whole-event chip counts and **Export CSV** / **Export emails** for every match
  (disabled, with a reason, when nothing matches); Teams, Judging → Submissions and Results have the
  same **Export CSV**; Feedback → individual responses in numbered pages of 25; Invites in numbered
  pages of 50 (`PageNumberPager`, shared with Judging → Results) with an email search; Move to team
  a searchable list of teams with room, 20 at a time.
- **Views menu** (Guests → People and Teams, Judging → Submissions, Results, Progress;
  `components/event-dashboard/views/SavedViewsMenu.tsx`): a secondary small "Views" button reading
  "Views · <name>" when a preset or saved view matches ("Custom filters" otherwise), listing Presets,
  Your views, Shared views, then Save current view…, Manage views…, Copy link and Clear filters.
  Filters always sit in the address bar, so bookmarks and Back work too.
- **Account area:** header card + tabs Profile · Registrations · Organisations · Security, each a column
  of `AccountCard`s. Registrations sections show 50 at a time with page-number links
  (`?past=2#past`) that keep the other sections' pages.

---

## 6. Content & voice

- Clear, warm, specific. Second person. Sentence case everywhere (buttons, headings, tabs).
- Name the action: "Register — it's free", "Save new password" — not "Submit" or "OK".
- Empty states name the next step. Errors say what happened and how to fix it, without blame:
  "Couldn't save. Try again." **Banned:** "Oops", "Something went wrong".
- Never show raw internals: no RRULE strings, no full secret URLs, no seconds, no `10/14/2026`.
- en-GB spelling: "organisation", "organiser".
- Dates and times go through one formatter in the event's timezone (`Wed 14 Oct`, `9:30 AM – 5:30 PM IST`,
  `Today / Tomorrow / In 9 days`). Show the timezone once per section. No countdown timers in lists.

---

## 7. Accessibility checklist

- Every text/background token pair is ≥ 4.5:1 (checked for light and dark when tokens change).
  `text-ink-muted` is the lightest readable text. Form-control outlines and focus rings are ≥ 3:1.
- No translucent text (`text-*/75` is banned); use a solid token.
- Status never by colour alone (word required, icon optional).
- Every input has a `<label>`; errors linked with `aria-describedby`.
- Real `<button>` / `<a href>`; tabs `role="tab"` + `aria-selected`; toggles `aria-pressed`; nav
  `aria-current`.
- Visible focus ring everywhere: 2px, offset 2px, teal (light) / Citron (dark), accent text on event pages.
- Touch targets ≥ 44px; kiosk ≥ 64px.
- Works at 360px with no horizontal page scroll.
- `prefers-reduced-motion` respected; `prefers-color-scheme` sets the default theme, with a Light/Dark
  toggle stored in the `swe.color-mode` cookie and `swe:color-mode` local storage.

---

## 8. Dark mode

- A full theme built from the brand's reversed pairings: Deep Ink ground, teal-lit panels, cream text.
  **No black.**
- Primary stays Maker Teal with cream labels. Focus becomes Citron.
- Status pills switch from solid pastels to soft fills with the brand colour as the word.
- Event accents keep their fill; text uses the lighter `--yy-accent-text`.
- Overlays keep the same Deep Ink shadow; rely on hairlines and panel steps for structure.
- QR codes stay on a white plate. Physical materials (letter, badges, photo-editor stage) keep their own
  colours.
- The mode is `data-color-mode` on `<html>` (set from the cookie on the server, so there is no flash),
  or follows the system when unset. `.yy-dark-band` forces dark tokens on one band.

---

## 9. Implementing in this codebase

Stack: Next.js 16 App Router, React 19, TypeScript, **Tailwind 4**, **Radix UI**, **lucide-react**,
framer-motion. Fonts are self-hosted (§2.6). Keep Server Components by default and never weaken the
security invariants (CSP nonce, tenant isolation). Don't add external scripts, fonts or image hosts.

### 9.1 One source of truth for tokens

1. `app/styles/tokens.css` declares every token as `--yy-*` (plus raw `--sw-*` brand colours). Light
   values go under `:root`. Dark values go under `:root[data-color-mode="dark"], .yy-dark-band` **and**
   the `@media (prefers-color-scheme: dark) { :root:not([data-color-mode]) }` mirror. Keep all three in
   sync.
2. `app/globals.css` maps them in `@theme inline` (`--color-canvas: var(--yy-bg-canvas)`, …), defines
   fonts, radii, the type scale (`text-display-*`, `text-h*`, `text-body*`, `text-label`, `text-caption`,
   `text-overline`) and `.font-accent`.
3. Utility names other code relies on: `canvas panel surface subtle muted emphasis track line
   line-strong ink ink-secondary ink-muted ink-disabled primary primary-hover primary-active on-primary
   inverse on-inverse highlight highlight-hover on-highlight highlight-soft sidebar sidebar-hover
   sidebar-active on-sidebar-active success-bg/fg/solid warning-bg/fg/solid info-bg/fg/solid
   danger-bg/fg/solid/border danger-hover on-danger on-success on-warning on-info accent accent-soft
   on-accent accent-text
   sw-ink sw-teal sw-orange sw-citron sw-sky sw-yellow sw-cream`, shadows `shadow-raised shadow-float
   shadow-ticket shadow-segment`, radius `rounded-control`, fonts `font-sans font-display font-accent
   font-mono`.
4. UI primitives live in `components/ui/*`; brand components in `components/brand/*`.

### 9.2 Event accent at runtime

The event page root sets `style={accentStyle(event.accentColor)}` and `className="yy-accent-scope"`.
`accentStyle` returns `--yy-accent-*-light` / `-dark` pairs; the scope picks the right set for the
current mode. Validate the hex server-side (zod); only a normalised `#RRGGBB` ever reaches CSS.

### 9.3 Do / Don't

**Do:** use tokens; one primary action per view; label fields above; keep event accents on event
surfaces; test light + dark + 360px.

**Don't:** shadows on cards; hover lifts; `opacity-50` for disabled buttons; orange text; translucent
text; `text-white` on a status fill; black; gradient text or buttons; Unbounded in dashboard chrome or
more than once per layout; icons in the sidebar; recoloured or re-typed logos; cards in cards in cards;
emoji; countdown timers; colour-only status.

---

*Version 2.0 · 18 Oct 2026 · Space Works Events rebrand of the Yuyu design system (v1.2, 15 Oct 2026).
Brand values from SpaceWorks-Labs/SpaceWorks-Design.*
