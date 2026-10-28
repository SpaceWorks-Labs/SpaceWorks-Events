import { loadMyStaffClaims } from "@/lib/mobile/attendee";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileOk } from "@/lib/mobile/http";

/** The caller's own expense claims on this event. */
export const GET = eventRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/finance/claims/mine", (permissions) => permissions.fileClaims, async (_request, _params, { auth, event }) =>
  mobileOk(await loadMyStaffClaims(auth.userId, event.event.id)));
