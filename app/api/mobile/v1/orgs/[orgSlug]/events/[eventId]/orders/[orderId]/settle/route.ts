import { z } from "zod";
import { settlePaidOrder } from "@/app/actions/payment-operations";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk, notFound, parseJsonBody } from "@/lib/mobile/http";
import { loadOrganiserOrder } from "@/lib/mobile/orders";

type Params = { orgSlug: string; eventId: string; orderId: string };

const bodySchema = z.object({ mode: z.enum(["offline", "waive"]), method: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CARD_TERMINAL", "OTHER"]).optional(), reference: z.string().max(120).optional() }).strict();

/**
 * Settle at the desk: money collected in person (`offline` with a method)
 * or complimentary (`waive`). Confirms held tickets and releases nothing.
 */
export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/orders/:orderId/settle", (permissions) => permissions.manageOrders, async (request, { orderId }, { event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await settlePaidOrder({ organisationSlug: event.organisation.slug, eventId: event.event.id, orderId, ...body.data });
  if (!result.ok) return result.error === "Order not found." ? notFound() : mobileActionError(result);
  const order = await loadOrganiserOrder(event.event.id, orderId);
  return order ? mobileOk(order) : notFound();
}, { idempotent: true });
