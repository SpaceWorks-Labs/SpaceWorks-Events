import { mobileOk } from "@/lib/mobile/http";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { loadOrgEventDetail } from "@/lib/mobile/organiser";

export const GET = eventRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId", null, async (_request, _params, { event, baseUrl }) =>
  mobileOk(await loadOrgEventDetail(event, baseUrl)));
