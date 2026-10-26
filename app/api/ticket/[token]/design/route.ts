import { checkRateLimitById, getClientIpFromHeaders } from "@/lib/rateLimit";
import { renderDesignPdf, renderDesignPng } from "@/lib/ticketDesign/render";
import { ticketDesignFor } from "@/lib/ticketDesign/resolve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ token: string }> };

const HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } as const;
const notFound = () => new Response(null, { status: 404, headers: HEADERS });
const file = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "event";

/**
 * The designed ticket (docs/TICKET_DESIGNER.md) for a confirmed registration:
 * `?format=png` (default) or `pdf`, `inline=1` to show it on the ticket page.
 * The ticket token is the bearer proof, as for the plain download; the QR
 * encodes it. Rate limited per address; empty 404 otherwise.
 */
export async function GET(request: Request, context: RouteContext) {
  const { token } = await context.params;
  const safeToken = token.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(safeToken)) return notFound();
  if (!(await checkRateLimitById("ticketStatus", `design:${getClientIpFromHeaders(request.headers)}`))) return new Response(null, { status: 429, headers: { ...HEADERS, "Retry-After": "60" } });
  const ticket = await ticketDesignFor(safeToken);
  if (!ticket || ticket.status !== "CONFIRMED") return notFound();
  const url = new URL(request.url);
  const pdf = url.searchParams.get("format") === "pdf";
  const disposition = url.searchParams.get("inline") === "1" ? "inline" : `attachment; filename="${file(ticket.title)}-ticket.${pdf ? "pdf" : "png"}"`;
  if (pdf) {
    const bytes = await renderDesignPdf(ticket.document, ticket.values, safeToken, `${ticket.title} ticket`);
    return new Response(Uint8Array.from(bytes).buffer, { headers: { ...HEADERS, "Content-Type": "application/pdf", "Content-Disposition": disposition } });
  }
  // The page shows a lighter 200 dpi image; downloads are print quality.
  const png = await renderDesignPng(ticket.document, ticket.values, safeToken, disposition === "inline" ? 200 : 300);
  return new Response(Uint8Array.from(png).buffer, { headers: { ...HEADERS, "Content-Type": "image/png", "Content-Disposition": disposition } });
}
