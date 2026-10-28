import { z } from "zod";
import { undoCheckInForUser } from "@/lib/core/checkin";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk, parseJsonBody } from "@/lib/mobile/http";

const bodySchema = z.object({ rsvpId: z.string().min(1).max(128) }).strict();

export const POST = eventRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/check-in/undo", null, async (request, _params, { auth, event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await undoCheckInForUser(auth.userId, { organisationSlug: event.organisation.slug, eventId: event.event.id, rsvpId: body.data.rsvpId }, { source: "mobile-manual" });
  if (!result.ok) return mobileActionError(result);
  return mobileOk(null);
});
