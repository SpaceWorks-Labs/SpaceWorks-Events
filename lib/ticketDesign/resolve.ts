import "server-only";

import { prisma } from "@/lib/db";
import { formatDayLong, formatTimeRange } from "@/lib/format/datetime";
import { formatMoney } from "@/lib/payments/money";
import { safeTimeZone } from "@/lib/timeZone";
import { registrationNumber, type MergeValues } from "./fields";
import { CLASSIC_DESIGN } from "./presets";
import { designDocumentSchema, type DesignDocument } from "./schema";

/**
 * Which design a ticket uses (docs/TICKET_DESIGNER.md): its ticket type's,
 * else its event's, else the organisation's default, else the built-in
 * Classic design; and the merge-field values printed on it. `custom` is
 * false for the built-in design.
 */

function parse(document: unknown): DesignDocument | null {
  const parsed = designDocumentSchema.safeParse(document);
  return parsed.success ? parsed.data : null;
}

export async function ticketDesignFor(checkInToken: string) {
  const rsvp = await prisma.rSVP.findUnique({
    where: { checkInToken },
    select: {
      id: true, status: true, checkedInAt: true, guestName: true, guestEmail: true,
      user: { select: { name: true } },
      team: { select: { name: true } },
      order: { select: { reference: true, currency: true } },
      ticketType: { select: { name: true, priceMinor: true, ticketDesign: { select: { document: true } } } },
      event: { select: { title: true, startDateTime: true, endDateTime: true, timezone: true, location: true, isOnline: true, currency: true, ticketDesign: { select: { document: true } }, organisation: { select: { name: true, defaultTicketDesign: { select: { document: true } } } } } },
      eventInstance: { select: { startDateTime: true, endDateTime: true, series: { select: { title: true, timezone: true, currency: true, organisation: { select: { name: true, defaultTicketDesign: { select: { document: true } } } } } } } },
    },
  });
  if (!rsvp) return null;
  const owner = rsvp.event ?? rsvp.eventInstance?.series;
  if (!owner) return null;
  const organisation = owner.organisation;
  const chosen = [rsvp.ticketType?.ticketDesign?.document, rsvp.event?.ticketDesign?.document, organisation.defaultTicketDesign?.document].map((document) => (document ? parse(document) : null)).find(Boolean) ?? null;
  const start = rsvp.event?.startDateTime ?? rsvp.eventInstance!.startDateTime;
  const end = rsvp.event?.endDateTime ?? rsvp.eventInstance!.endDateTime;
  const timeZone = safeTimeZone(owner.timezone);
  const currency = rsvp.order?.currency ?? owner.currency;
  const values: MergeValues = {
    name: rsvp.user?.name?.trim() || rsvp.guestName?.trim() || rsvp.guestEmail?.split("@")[0] || "Guest",
    event: owner.title,
    date: formatDayLong(start, timeZone),
    time: formatTimeRange(start, end, timeZone, { withZone: true }),
    // Series dates have no venue of their own.
    venue: rsvp.event ? (rsvp.event.isOnline ? "Online" : rsvp.event.location.trim()) : "",
    ticket: rsvp.ticketType?.name ?? "",
    price: rsvp.ticketType ? (rsvp.ticketType.priceMinor > BigInt(0) && currency ? formatMoney(rsvp.ticketType.priceMinor, currency) : "Free") : "",
    order: rsvp.order?.reference ?? "",
    registration: registrationNumber(rsvp.id),
    team: rsvp.team?.name ?? "",
    organisation: organisation.name,
  };
  return { status: rsvp.status, checkedIn: rsvp.checkedInAt != null, document: chosen ?? CLASSIC_DESIGN, custom: Boolean(chosen), values, title: owner.title };
}

/** Above this the email keeps only the ticket link. */
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

/**
 * The designed ticket as a PDF for the confirmation email, when the ticket
 * has a custom design (the built-in one isn't attached). Never throws: a
 * render failure or a large file just leaves the attachment off.
 */
export async function designedTicketAttachment(checkInToken: string) {
  try {
    const ticket = await ticketDesignFor(checkInToken);
    if (!ticket?.custom || ticket.status !== "CONFIRMED") return undefined;
    const { renderDesignPdf } = await import("./render");
    const pdf = await renderDesignPdf(ticket.document, ticket.values, checkInToken, `${ticket.title} ticket`);
    if (pdf.byteLength > MAX_ATTACHMENT_BYTES) return undefined;
    const name = ticket.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "event";
    return { filename: `${name}-ticket.pdf`, content: Buffer.from(pdf) };
  } catch {
    console.error("[tickets] designed ticket attachment failed");
    return undefined;
  }
}
