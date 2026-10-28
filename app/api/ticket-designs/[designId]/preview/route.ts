import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { checkRateLimitById } from "@/lib/rateLimit";
import { resolveDesignActor, editableDesign } from "@/lib/ticketDesign/access";
import { SAMPLE_VALUES } from "@/lib/ticketDesign/fields";
import { renderDesignPng } from "@/lib/ticketDesign/render";
import { ticketDesignFor } from "@/lib/ticketDesign/resolve";
import { designDocumentSchema } from "@/lib/ticketDesign/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ designId: string }> };

const HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } as const;
const notFound = () => new Response(null, { status: 404, headers: HEADERS });

/**
 * The ticket designer's preview (docs/TICKET_DESIGNER.md): the saved design
 * rendered exactly as tickets will be, with sample values, or (event designs
 * only) a real registration's values from `?rsvp=<id>`, whose QR is replaced
 * by a sample so the preview never carries a live ticket. Same people as
 * editing the design; empty 404 otherwise.
 */
export async function GET(request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return notFound();
  const url = new URL(request.url);
  const organisationSlug = url.searchParams.get("org") ?? "";
  const actor = organisationSlug ? await resolveDesignActor(userId, organisationSlug) : null;
  if (!actor) return notFound();
  if (!(await checkRateLimitById("search", `design-preview:${userId}`))) return new Response(null, { status: 429, headers: { ...HEADERS, "Retry-After": "60" } });
  const { designId } = await context.params;
  const design = await editableDesign(actor, designId);
  const document = design ? designDocumentSchema.safeParse(design.document) : null;
  if (!design || !document?.success) return notFound();
  let values = SAMPLE_VALUES;
  const rsvpId = url.searchParams.get("rsvp");
  if (rsvpId && design.eventId) {
    const rsvp = await prisma.rSVP.findFirst({ where: { id: rsvpId.slice(0, 128), eventId: design.eventId }, select: { checkInToken: true } });
    const ticket = rsvp ? await ticketDesignFor(rsvp.checkInToken) : null;
    if (ticket) values = ticket.values;
  }
  const png = await renderDesignPng(document.data, values, "preview-only-not-a-ticket", 150);
  return new Response(Uint8Array.from(png).buffer, { headers: { ...HEADERS, "Content-Type": "image/png", "Content-Disposition": "inline" } });
}
