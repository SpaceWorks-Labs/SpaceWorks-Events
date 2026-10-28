import { z } from "zod";
import { refundPaidOrder } from "@/app/actions/payment-operations";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk, notFound, parseJsonBody } from "@/lib/mobile/http";
import { loadOrganiserOrder } from "@/lib/mobile/orders";

type Params = { orgSlug: string; eventId: string; orderId: string };

const bodySchema = z.object({ amount: z.string().max(20).optional(), reason: z.string().max(500), cancelTickets: z.boolean().optional() }).strict();

/** Refund the order through its provider (blank amount refunds everything still refundable), optionally cancelling its tickets. */
export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/orders/:orderId/refund", (permissions) => permissions.manageOrders, async (request, { orderId }, { event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await refundPaidOrder({ organisationSlug: event.organisation.slug, eventId: event.event.id, orderId, ...body.data });
  if (!result.ok) return result.error === "Order not found." ? notFound() : mobileActionError(result);
  const order = await loadOrganiserOrder(event.event.id, orderId);
  return order ? mobileOk(order) : notFound();
});
