import { z } from "zod";
import { previewCheckInByRsvpIdForUser, previewCheckInByTokenForUser } from "@/lib/core/checkin";
import { toCheckInPreview } from "@/lib/mobile/checkIn";
import { paymentInfoForRsvp } from "@/lib/mobile/orders";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, parseJsonBody } from "@/lib/mobile/http";

const bodySchema = z.object({
  rawInput: z.string().max(2048).optional(),
  rsvpId: z.string().max(128).optional(),
}).strict().refine((value) => Boolean(value.rawInput) !== Boolean(value.rsvpId), { message: "Send exactly one of rawInput or rsvpId." });

export const POST = eventRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/check-in/preview", null, async (request, _params, { auth, event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const target = { organisationSlug: event.organisation.slug, eventId: event.event.id };
  const result = body.data.rawInput
    ? await previewCheckInByTokenForUser(auth.userId, { ...target, rawInput: body.data.rawInput })
    : await previewCheckInByRsvpIdForUser(auth.userId, { ...target, rsvpId: body.data.rsvpId });
  if (!result.ok) return mobileActionError(result);
  if (!result.data) return mobileError("INTERNAL_ERROR");
  return mobileOk(toCheckInPreview(result.data, await paymentInfoForRsvp(event.event.id, result.data.rsvpId)));
});
