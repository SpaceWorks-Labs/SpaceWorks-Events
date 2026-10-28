import { cancelOrderForBuyer } from "@/lib/core/orders/buyer";
import { mobileActionError, mobileOk, notFound } from "@/lib/mobile/http";
import { loadMyOrder } from "@/lib/mobile/orders";
import { authedMobileRoute } from "@/lib/mobile/route";

/**
 * Cancel the whole order under the refund policy frozen when it was bought
 * (the order page's own body). Once the policy allows no refund, ask instead:
 * POST /me/orders/:orderId/refund-request.
 */
export const POST = authedMobileRoute<{ orderId: string }>("POST /api/mobile/v1/me/orders/:orderId/cancel", async (_request, { orderId }, { auth }) => {
  const result = await cancelOrderForBuyer(orderId, auth.userId);
  if (!result.ok) return result.error === "Order not found." ? notFound() : mobileActionError(result);
  const order = await loadMyOrder(auth.userId, orderId);
  return order ? mobileOk(order) : notFound();
});
