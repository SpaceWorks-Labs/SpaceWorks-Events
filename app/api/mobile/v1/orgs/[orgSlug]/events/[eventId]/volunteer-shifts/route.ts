import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileOk } from "@/lib/mobile/http";
import { loadRosterDto } from "@/lib/mobile/volunteers";

/** Guests → Crew → Shifts: shifts, sign-ups, attendance, hours and contributors (MANAGE_REGISTRATIONS; docs/VOLUNTEERS.md). */
export const GET = eventRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/volunteer-shifts", (permissions) => permissions.manageCrew, async (_request, _params, { auth, event }) =>
  mobileOk(await loadRosterDto(event, auth.userId)));
