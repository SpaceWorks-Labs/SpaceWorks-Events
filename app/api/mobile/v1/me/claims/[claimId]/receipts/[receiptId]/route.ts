import { prisma } from "@/lib/db";
import { notFound } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";
import { checkRateLimitById } from "@/lib/rateLimit";
import { downloadReceipt } from "@/lib/storage/private";

/**
 * A receipt photo from one of the caller's own claims (staff or participant).
 * Organisers read other people's receipts on the website. Every denial is the
 * same NOT_FOUND; the file is never cached.
 */
export const GET = authedMobileRoute<{ claimId: string; receiptId: string }>("GET /api/mobile/v1/me/claims/:claimId/receipts/:receiptId", async (_request, { claimId, receiptId }, { auth }) => {
  if (!claimId || !receiptId || claimId.length > 128 || receiptId.length > 128) return notFound();
  if (!(await checkRateLimitById("search", `receipt:${auth.userId}`))) return notFound();
  const receipt = await prisma.expenseReceipt.findFirst({
    where: { id: receiptId, claimId, claim: { OR: [{ submittedByUserId: auth.userId }, { rsvp: { userId: auth.userId } }] } },
    select: { storageKey: true },
  });
  if (!receipt) return notFound();
  const body = await downloadReceipt(receipt.storageKey).catch(() => null);
  if (!body) return notFound();
  return new Response(Uint8Array.from(body).buffer, {
    headers: { "Content-Type": "image/webp", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
});
