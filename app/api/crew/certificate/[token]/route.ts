import { notFound } from "next/navigation";
import { loadContributorCertificate } from "@/lib/volunteer/certificates";
import { renderContributorCertificate } from "@/lib/volunteer/certificateImage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const filename = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "event";

/**
 * A contributor certificate download (docs/VOLUNTEERS.md). The token is a
 * bearer capability shown only on the crew ticket. Revoked certificates,
 * removed crew and certificates whose hours changed are "not found".
 */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const certificate = await loadContributorCertificate(token);
  if (!certificate) notFound();
  const jpeg = await renderContributorCertificate(certificate);
  return new Response(new Uint8Array(jpeg), {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Disposition": `attachment; filename="${filename(certificate.crewMember.event.title)}-contributor-certificate.jpg"`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
