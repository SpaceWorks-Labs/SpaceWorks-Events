import { z } from "zod";
import { lookupAttendeesForCheckInForUser } from "@/lib/core/checkin";
import { loadGuestFacts, lookupRowToGuest } from "@/lib/mobile/checkIn";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk, parseQuery } from "@/lib/mobile/http";
import { lookupDtoSchema } from "@/lib/mobile/schemas";

const querySchema = z.object({ q: z.string().trim().min(2).max(200) }).strict();

export const GET = eventRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/check-in/lookup", null, async (request, _params, { auth, event }) => {
  const query = parseQuery(request, querySchema);
  if ("response" in query) return query.response;
  const result = await lookupAttendeesForCheckInForUser(auth.userId, { organisationSlug: event.organisation.slug, eventId: event.event.id, query: query.data.q });
  if (!result.ok) return mobileActionError(result);
  const rows = result.data?.rows ?? [];
  const facts = await loadGuestFacts(event.event.id, rows.map((row) => row.rsvpId));
  return mobileOk(lookupDtoSchema.parse({ rows: rows.map((row) => lookupRowToGuest(row, facts)) }));
});
