import { z } from "zod";
import { decideRefundRequestAction } from "@/app/actions/finance";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { loadEventClaims } from "@/lib/mobile/finance";
import { mobileActionError, mobileOk, notFound, parseJsonBody } from "@/lib/mobile/http";
import { prisma } from "@/lib/db";

type Params = { orgSlug: string; eventId: string; requestId: string };

const bodySchema = z.object({
  decision: z.enum(["approve", "decline"]),
  amount: z.string().max(20).optional(),
  cancelTickets: z.boolean().optional(),
  note: z.string().max(500).optional(),
}).strict();

/** Approve (running the refund) or decline a buyer's refund request, by the Finance tab's own action. */
export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/finance/refund-requests/:requestId/decide", (permissions) => permissions.manageFinance, async (request, { requestId }, { event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  // The request must be on an order of the event in the path.
  if (!(await prisma.refundRequest.findFirst({ where: { id: requestId, order: { eventId: event.event.id } }, select: { id: true } }))) return notFound();
  const result = await decideRefundRequestAction({ organisationSlug: event.organisation.slug, eventId: event.event.id }, { requestId, ...body.data });
  if (!result.ok) return mobileActionError(result);
  return mobileOk(await loadEventClaims(event.event.id));
});
