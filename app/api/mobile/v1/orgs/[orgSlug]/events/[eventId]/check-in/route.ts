import { z } from "zod";
import { checkInByRsvpIdForUser, checkInByTokenForUser } from "@/lib/core/checkin";
import { toCheckInResult } from "@/lib/mobile/checkIn";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, parseJsonBody } from "@/lib/mobile/http";

const bodySchema = z.object({
  rawInput: z.string().max(2048).optional(),
  rsvpId: z.string().max(128).optional(),
  force: z.boolean().default(false),
}).strict().refine((value) => Boolean(value.rawInput) !== Boolean(value.rsvpId), { message: "Send exactly one of rawInput or rsvpId." });

/** Check in through the shared core, which commits via commitCheckInProjection (live ticket tear included). */
export const POST = eventRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/check-in", null, async (request, _params, { auth, event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const target = { organisationSlug: event.organisation.slug, eventId: event.event.id, force: body.data.force };
  const result = body.data.rawInput
    ? await checkInByTokenForUser(auth.userId, { ...target, rawInput: body.data.rawInput }, { source: "mobile-scan" })
    : await checkInByRsvpIdForUser(auth.userId, { ...target, rsvpId: body.data.rsvpId }, { source: "mobile-manual" });
  if (!result.ok) return mobileActionError(result);
  return result.data ? mobileOk(toCheckInResult(result.data)) : mobileError("INTERNAL_ERROR");
});
