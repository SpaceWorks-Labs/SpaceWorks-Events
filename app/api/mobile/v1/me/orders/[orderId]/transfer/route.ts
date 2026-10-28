import { z } from "zod";
import { transferTicketForBuyer } from "@/lib/core/orders/buyer";
import { mobileActionError, mobileOk, notFound, parseJsonBody } from "@/lib/mobile/http";
import { loadMyOrder } from "@/lib/mobile/orders";
import { authedMobileRoute } from "@/lib/mobile/route";

const bodySchema = z.object({ rsvpId: z.string().min(1).max(64), name: z.string().max(200), email: z.string().max(320) }).strict();

/** Give one holder's ticket (every remaining date, for a pass) to someone else, where the organiser allows it. */
export const POST = authedMobileRoute<{ orderId: string }>("POST /api/mobile/v1/me/orders/:orderId/transfer", async (request, { orderId }, { auth }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await transferTicketForBuyer(orderId, auth.userId, body.data);
  if (!result.ok) return result.error === "Order not found." ? notFound() : mobileActionError(result);
  const order = await loadMyOrder(auth.userId, orderId);
  return order ? mobileOk(order) : notFound();
}, { idempotent: true });
