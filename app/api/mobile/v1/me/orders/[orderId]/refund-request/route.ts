import { z } from "zod";
import { requestRefundForBuyer } from "@/lib/core/orders/buyer";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { mobileActionError, mobileError, mobileOk, notFound, parseJsonBody } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";

const bodySchema = z.object({ reason: z.string().max(1000) }).strict();

/** Ask the organisers for a refund outside the automatic policy (docs/FINANCE.md), once at a time. */
export const POST = authedMobileRoute<{ orderId: string }>("POST /api/mobile/v1/me/orders/:orderId/refund-request", async (request, { orderId }, { auth }) => {
  if (await isActionRateLimited("action", auth.userId)) return mobileError("RATE_LIMITED");
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await requestRefundForBuyer(orderId, auth.userId, body.data.reason);
  if (!result.ok) return result.error === "Order not found." ? notFound() : mobileActionError(result);
  return mobileOk(null, 201);
});
