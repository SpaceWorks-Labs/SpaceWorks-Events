import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileOk } from "@/lib/mobile/http";
import { loadBroadcastsMeta } from "@/lib/mobile/organiser";

export const GET = eventRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/broadcasts/meta", (permissions) => permissions.sendEmails, async (_request, _params, { event }) =>
  mobileOk(await loadBroadcastsMeta(event)));
