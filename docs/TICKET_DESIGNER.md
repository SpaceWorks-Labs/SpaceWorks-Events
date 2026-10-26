# Ticket designer

Organisations design their tickets like a poster: text, images, shapes,
lines and ticket details, laid out around the one check-in QR code. A
designed ticket shows on the ticket page and is the PNG and PDF download.
It is also attached as a PDF to the confirmation email.

## Which design a ticket uses

1. The ticket type's own design, if the event gave it one.
2. Otherwise the event's design.
3. Otherwise the organisation's **default** from its library.
4. Otherwise the built-in **Classic** design.

`lib/ticketDesign/resolve.ts` (`ticketDesignFor`) applies this order. Only
steps 1–3 count as a custom design (`custom`). The built-in design is used for
downloads but is not attached to emails or shown above the ticket stub.

## Where designs live

- `TicketDesign` rows. Without an `eventId`, a design is a **library
  template**: **Dashboard → Settings → Ticket designs**
  (`/dashboard/:orgSlug/ticket-designs`), for organisation owners and admins.
  They create templates from a starter, edit, delete, and choose the default
  (`Organisation.defaultTicketDesignId`).
- With an `eventId`, a design belongs to that event: event **Settings →
  Ticket design**, for anyone with `EDIT_DETAILS` on the event (the same
  people as ticket prices). From there you:
  - start a design from a library template (a copy) or a starter;
  - choose the event's design (`Event.ticketDesignId`) and any ticket type's
    own design (`TicketType.ticketDesignId`);
  - edit or delete designs.

  An event's first design becomes its design automatically.
- Database triggers keep this honest:
  - an event's and a ticket type's design must be one of that event's own;
  - the organisation default must be one of its library templates.

  Deleting a design sets every reference to it back to null (the ticket falls
  back a step). Limits: 50 library templates and 20 designs per event. A
  document is at most 256 KB.

## The editor

`/dashboard/:orgSlug/ticket-designs/:designId` (`components/ticket-designer/`).

- **Elements:**
  - text, with merge fields;
  - images uploaded to the organisation: re-encoded WebP under
    `organisations/:id/ticket-design-images/`, never remote URLs;
  - rectangles (corner radius), ellipses, lines (dashed for a tear line);
  - the QR code.
- **Merge fields** (`lib/ticketDesign/fields.ts`), written `{{key}}`: `name`,
  `event`, `date`, `time` (in the event's timezone), `venue`, `ticket`,
  `price`, `order`, `registration` (a short number from the registration id,
  not a secret), `team` and `organisation`. Unknown or empty fields print
  nothing.
- **Editing:**
  - layers: reorder, hide, lock;
  - drag to move, snapping to the canvas and other elements' edges and
    centres with guides (Alt turns snapping off);
  - handles to resize; the top handle rotates (in 15° steps near them);
  - align to the canvas;
  - copy/paste and duplicate (Ctrl/Cmd+C, V, D); undo/redo (Ctrl/Cmd+Z,
    Shift+Z or Y); arrows nudge 0.5 mm (Shift: 5 mm); Delete removes;
  - an inspector for position, size, rotation, opacity, font, colour and so
    on;
  - canvas size presets (ticket stub, wide, A6 both ways, phone, 4 × 6 in
    badge) or a custom size from 40 to 300 mm;
  - starter designs (Classic stub, Night pass, Portrait card).
- **Autosave:** about 1.5 s after the last change (`designAutosave` rate-limit
  bucket). Only documents the server would accept are sent; a problem (for
  example a missing QR) shows instead.
- **Preview:** renders the saved design on the server exactly as tickets will
  look, with sample values. For an event's design, it can show one of its 50
  newest registrations instead. The preview's QR is always a sample.
- **Fonts:** Gilroy (regular, medium, semibold, bold), Unbounded (its default
  weight), DejaVu Sans and DejaVu Serif (regular and bold, in
  `public/fonts/dejavu/` with their licence). The editor and the renderer load
  the same files. Characters a font lacks are drawn in DejaVu Sans.

## The QR code

Every design has exactly one QR code (`lib/ticketDesign/schema.ts`). The
schema refuses any design where it is:

- missing, or one of several;
- smaller than 18 mm;
- hidden, rotated or faded;
- partly off the ticket.

It is always drawn black on a white plate with a quiet zone, and encodes the
ticket's own check-in token. A designed ticket is never shown on the ticket
page once the guest has checked in, like the QR stub.

## Rendering and delivery

- `lib/ticketDesign/render.ts` turns the document into an SVG in
  millimetres:
  - text becomes glyph outlines, wrapped to its box with the real font
    metrics, and lines that don't fit are dropped;
  - images come only from managed uploads;
  - the QR is drawn as vector modules.

  sharp rasterises it. The **PNG** is 300 dpi (200 dpi on the ticket page).
  The **PDF** holds the 300 dpi image at the ticket's exact size.
- `GET /api/ticket/:token/design` (`?format=pdf`, `?inline=1`): the designed
  ticket for a confirmed registration. The ticket token is the proof. Rate
  limited per address, `private, no-store`.
- `GET /api/ticket-designs/:designId/preview?org=…[&rsvp=…]`: the editor
  preview, for whoever may edit the design.
- The confirmation email (and the approval email that confirms a place)
  attaches the PDF when the ticket has a custom design and it is under 2 MB.
  A render failure never stops the email; it keeps the ticket link.

## Tests

- Unit: `tests/unit/ticket-design.test.ts`. Starters are valid; every QR rule
  is enforced; unknown fonts, bad colours, duplicate ids and extra keys are
  refused; merge fields; snapping, alignment, new and duplicated elements.
- PostgreSQL: `tests/integration/ticket-designs.db.test.ts`.
  - Library vs event permissions.
  - Image ownership on save.
  - The placement triggers.
  - The resolution order.
  - The email PDF attachment.
