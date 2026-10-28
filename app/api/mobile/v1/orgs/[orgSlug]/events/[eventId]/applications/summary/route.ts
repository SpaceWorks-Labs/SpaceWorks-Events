import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileOk } from "@/lib/mobile/http";
import { loadApplicationsSummary } from "@/lib/mobile/admissionCounts";

/**
 * Applications at a glance (docs/ADMISSION.md), read-only: counts by status
 * and stage, offers out against the limit, the waitlist and drafted
 * decisions. The same people as the Applications tab (OWNER/ADMIN or
 * MANAGE_REGISTRATIONS), on events taking applications. Numbers only.
 */
export const GET = eventRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/applications/summary", (permissions) => permissions.manageApplications, async (_request, _params, { event }) =>
  mobileOk(await loadApplicationsSummary(event.event.id)));
