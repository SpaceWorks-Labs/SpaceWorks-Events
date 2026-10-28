import { mobileOk, notFound } from "@/lib/mobile/http";
import { loadMyOrder } from "@/lib/mobile/orders";
import { authedMobileRoute } from "@/lib/mobile/route";

/** One of the caller's orders, as the order page shows it. Anyone else's is NOT_FOUND. */
export const GET = authedMobileRoute<{ orderId: string }>("GET /api/mobile/v1/me/orders/:orderId", async (_request, { orderId }, { auth }) => {
  const order = await loadMyOrder(auth.userId, orderId);
  return order ? mobileOk(order) : notFound();
});
