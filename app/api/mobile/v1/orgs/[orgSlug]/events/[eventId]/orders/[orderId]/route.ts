import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileOk, notFound } from "@/lib/mobile/http";
import { loadOrganiserOrder } from "@/lib/mobile/orders";

type Params = { orgSlug: string; eventId: string; orderId: string };

/** An order of this event: buyer, money (paid, refunded, owed) and its tickets. */
export const GET = eventRoute<Params>("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/orders/:orderId", (permissions) => permissions.manageOrders, async (_request, { orderId }, { event }) => {
  const order = await loadOrganiserOrder(event.event.id, orderId);
  return order ? mobileOk(order) : notFound();
});
