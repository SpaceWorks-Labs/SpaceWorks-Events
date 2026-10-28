import { z } from "zod";
import { undoListCheckInForUser } from "@/lib/core/checkinLists/desk";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk, parseJsonBody } from "@/lib/mobile/http";

type Params = { orgSlug: string; eventId: string; listId: string };

const bodySchema = z.object({ rsvpId: z.string().min(1).max(128) }).strict();

/** Take a guest back out of a list. */
export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/check-in-lists/:listId/undo", (permissions) => permissions.checkInToLists, async (request, { listId }, { auth, event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await undoListCheckInForUser(auth.userId, { organisationSlug: event.organisation.slug, eventId: event.event.id, listId, rsvpId: body.data.rsvpId }, { source: "mobile-manual" });
  if (!result.ok) return mobileActionError(result);
  return mobileOk(null);
});
