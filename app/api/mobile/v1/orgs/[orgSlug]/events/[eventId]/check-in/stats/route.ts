import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileOk } from "@/lib/mobile/http";
import { loadCheckInStats } from "@/lib/mobile/organiser";

export const GET = eventRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/check-in/stats", (permissions) => permissions.checkIn, async (_request, _params, { event }) =>
  mobileOk(await loadCheckInStats(event)));
