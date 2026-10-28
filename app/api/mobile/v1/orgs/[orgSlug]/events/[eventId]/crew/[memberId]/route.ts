import { deleteCrewMember } from "@/app/actions/crew";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk } from "@/lib/mobile/http";

type Params = { orgSlug: string; eventId: string; memberId: string };

/** Remove a crew member and their free crew ticket, by Guests → Crew's own action. */
export const DELETE = eventRoute<Params>("DELETE /api/mobile/v1/orgs/:orgSlug/events/:eventId/crew/:memberId", (permissions) => permissions.manageCrew, async (_request, { memberId }, { event }) => {
  const result = await deleteCrewMember({ organisationSlug: event.organisation.slug, eventId: event.event.id, memberId });
  if (!result.ok) return mobileActionError(result);
  return mobileOk(null);
});
