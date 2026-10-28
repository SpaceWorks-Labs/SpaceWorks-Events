import { z } from "zod";
import { updateAttendeeForBuyer } from "@/lib/core/orders/buyer";
import { mobileActionError, mobileOk, notFound, parseJsonBody } from "@/lib/mobile/http";
import { loadMyOrder } from "@/lib/mobile/orders";
import { authedMobileRoute } from "@/lib/mobile/route";

const bodySchema = z.object({ name: z.string().max(200), email: z.string().max(320).optional(), answers: z.record(z.string(), z.unknown()).optional() }).strict();

/** Name a ticket's holder and answer the registration questions for them (the order page's own body). */
export const PATCH = authedMobileRoute<{ orderId: string; rsvpId: string }>("PATCH /api/mobile/v1/me/orders/:orderId/tickets/:rsvpId", async (request, { orderId, rsvpId }, { auth }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await updateAttendeeForBuyer(orderId, auth.userId, { rsvpId, ...body.data });
  if (!result.ok) return result.error === "Order not found." ? notFound() : mobileActionError(result);
  const order = await loadMyOrder(auth.userId, orderId);
  return order ? mobileOk(order) : notFound();
});
