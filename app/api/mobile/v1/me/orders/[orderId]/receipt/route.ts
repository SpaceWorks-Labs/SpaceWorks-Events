import { receiptForBuyer } from "@/lib/core/orders/buyer";
import { notFound } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";
import { createReceiptPdf } from "@/lib/payments/receipts";

/** The receipt (proof of payment) as a PDF, once money was collected. */
export const GET = authedMobileRoute<{ orderId: string }>("GET /api/mobile/v1/me/orders/:orderId/receipt", async (_request, { orderId }, { auth }) => {
  const receipt = await receiptForBuyer(orderId, auth.userId);
  if (!receipt) return notFound();
  const pdf = await createReceiptPdf(receipt);
  return new Response(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="receipt-${receipt.number}.pdf"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
