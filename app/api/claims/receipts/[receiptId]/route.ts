import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getMembership, isOrgAdmin } from "@/lib/permissions";
import { checkRateLimitById } from "@/lib/rateLimit";
import { downloadReceipt } from "@/lib/storage/private";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ receiptId: string }> };

const HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } as const;
const notFound = () => new Response(null, { status: 404, headers: HEADERS });

/**
 * One expense claim receipt photo (docs/FINANCE.md), for the claim's
 * organisation owners and admins, or the signed-in person who filed it.
 * Every denial is the same empty 404; the file is never cached or shared.
 */
export async function GET(_request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return notFound();
  const { receiptId } = await context.params;
  if (!receiptId || receiptId.length > 128) return notFound();
  if (!(await checkRateLimitById("search", `receipt:${userId}`))) return new Response(null, { status: 429, headers: { ...HEADERS, "Retry-After": "60" } });
  const receipt = await prisma.expenseReceipt.findUnique({ where: { id: receiptId }, select: { storageKey: true, claim: { select: { organisationId: true, submittedByUserId: true } } } });
  if (!receipt) return notFound();
  if (receipt.claim.submittedByUserId !== userId) {
    const membership = await getMembership(userId, receipt.claim.organisationId);
    if (!membership || !isOrgAdmin(membership.role)) return notFound();
  }
  const body = await downloadReceipt(receipt.storageKey).catch(() => null);
  if (!body) return notFound();
  return new Response(Uint8Array.from(body).buffer, {
    headers: { ...HEADERS, "Content-Type": "image/webp", "Content-Disposition": "inline", "Cross-Origin-Resource-Policy": "same-origin" },
  });
}
