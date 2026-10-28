import { z } from "zod";
import { sendOrderPaymentLink } from "@/app/actions/payment-operations";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk, notFound, parseJsonBody } from "@/lib/mobile/http";
import { loadOrganiserOrder } from "@/lib/mobile/orders";

type Params = { orgSlug: string; eventId: string; orderId: string };

const bodySchema = z.object({}).strict();

/** Email the buyer a fresh payment link for a held or requested order. */
export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/orders/:orderId/payment-link", (permissions) => permissions.manageOrders, async (request, { orderId }, { event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await sendOrderPaymentLink({ organisationSlug: event.organisation.slug, eventId: event.event.id, orderId, ...body.data });
  if (!result.ok) return result.error === "Order not found." ? notFound() : mobileActionError(result);
  const order = await loadOrganiserOrder(event.event.id, orderId);
  return order ? mobileOk(order) : notFound();
}, { idempotent: true });
