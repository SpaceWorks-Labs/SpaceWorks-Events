import { z } from "zod";
import { sendEventBroadcastForUser } from "@/lib/core/broadcasts";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, readJsonBody } from "@/lib/mobile/http";
import { broadcastSendDtoSchema } from "@/lib/mobile/schemas";

const bodySchema = z.object({ statuses: z.unknown(), attendance: z.unknown().optional(), subject: z.unknown(), body: z.unknown(), design: z.unknown().optional() }).strict();

/** Queue a broadcast through the same transaction, sanitiser, rate limit and audit as the dashboard. */
export const POST = eventRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/broadcasts", null, async (request, _params, { auth, event }) => {
  const body = await readJsonBody(request);
  if ("response" in body) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return mobileError("INVALID_REQUEST");
  const result = await sendEventBroadcastForUser(auth.userId, { ...parsed.data, organisationSlug: event.organisation.slug, eventId: event.event.id });
  if (!result.ok) return mobileActionError(result);
  return result.data ? mobileOk(broadcastSendDtoSchema.parse({ broadcastId: result.data.broadcastId, recipientCount: result.data.recipientCount }), 201) : mobileError("INTERNAL_ERROR");
});
