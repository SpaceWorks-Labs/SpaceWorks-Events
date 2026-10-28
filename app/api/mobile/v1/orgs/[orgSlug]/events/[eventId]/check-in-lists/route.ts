import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileOk } from "@/lib/mobile/http";
import { loadCheckInLists } from "@/lib/mobile/finance";

/** The event's custom check-in lists (swag, meals, sessions), for the list desk. */
export const GET = eventRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/check-in-lists", (permissions) => permissions.checkInToLists, async (_request, _params, { event }) =>
  mobileOk(await loadCheckInLists(event.event.id)));
