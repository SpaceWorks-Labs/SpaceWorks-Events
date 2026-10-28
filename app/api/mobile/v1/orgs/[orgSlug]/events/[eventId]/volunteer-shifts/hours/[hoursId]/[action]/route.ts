import { z } from "zod";
import { reviewVolunteerHours } from "@/app/actions/volunteer-shifts";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, parseJsonBody } from "@/lib/mobile/http";
import { loadRosterDto } from "@/lib/mobile/volunteers";

type Params = { orgSlug: string; eventId: string; hoursId: string; action: string };
const bodySchema = z.object({ minutes: z.number().int().min(0).max(1440).optional(), reason: z.string().max(500).optional() }).strict();

/**
 * Verify pending hours, or adjust verified ones (`minutes` and `reason`).
 * Organisation owners and admins only, never their own hours (a second person).
 */
export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/volunteer-shifts/hours/:hoursId/:action", (permissions) => permissions.manageCrew && permissions.manageFinance, async (request, { hoursId, action }, { auth, event }) => {
  if (action !== "verify" && action !== "adjust") return mobileError("NOT_FOUND");
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await reviewVolunteerHours({ organisationSlug: event.organisation.slug, eventId: event.event.id, hoursId, action, ...body.data });
  if (!result.ok) return mobileActionError(result);
  return mobileOk(await loadRosterDto(event, auth.userId));
});
