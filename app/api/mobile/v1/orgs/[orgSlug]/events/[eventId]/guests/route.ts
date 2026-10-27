import { z } from "zod";
import { addManualRsvpForUser } from "@/lib/core/rsvpAdmin";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, parseJsonBody, parseQuery } from "@/lib/mobile/http";
import { canSeeGuests, listGuests, loadGuest } from "@/lib/mobile/organiser";
import { guestSchema } from "@/lib/mobile/schemas";

const querySchema = z.object({
  status: z.enum(["ALL", "CONFIRMED", "WAITLISTED", "PENDING_APPROVAL", "REJECTED", "PENDING_PAYMENT"]).default("ALL"),
  checkedIn: z.enum(["any", "yes", "no"]).default("any"),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const GET = eventRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/guests", canSeeGuests, async (request, _params, { event }) => {
  const query = parseQuery(request, querySchema);
  if ("response" in query) return query.response;
  const result = await listGuests(event, query.data);
  return result ? mobileOk(result) : mobileError("INVALID_REQUEST", "Invalid cursor.");
});

const addSchema = z.object({
  name: z.string().max(200),
  email: z.string().max(320),
  answers: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** Add a guest exactly as the dashboard's "Add attendee" (addManualRsvp). */
export const POST = eventRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/guests", null, async (request, _params, { auth, event }) => {
  const body = await parseJsonBody(request, addSchema);
  if ("response" in body) return body.response;
  const result = await addManualRsvpForUser(auth.userId, {
    organisationSlug: event.organisation.slug,
    eventId: event.event.id,
    name: body.data.name,
    guestEmail: body.data.email,
    ...(body.data.answers ? { answers: body.data.answers } : {}),
  });
  if (!result.ok) return mobileActionError(result);
  const guest = result.data ? await loadGuest(event, result.data.rsvpId) : null;
  if (!guest) return mobileError("INTERNAL_ERROR");
  return mobileOk(guestSchema.parse(guest), 201);
});
