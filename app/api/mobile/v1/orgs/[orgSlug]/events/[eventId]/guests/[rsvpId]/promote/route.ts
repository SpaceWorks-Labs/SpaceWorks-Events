import { promoteFromWaitlistForUser } from "@/lib/core/rsvpLifecycle";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk, notFound } from "@/lib/mobile/http";
import { loadGuestAfterDecision } from "@/lib/mobile/organiser";

type Params = { orgSlug: string; eventId: string; rsvpId: string };

/** Same capacity transaction, notification email and audit as the dashboard. */
export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/guests/:rsvpId/promote", null, async (_request, { rsvpId }, { auth, event }) => {
  const result = await promoteFromWaitlistForUser(auth.userId, { organisationSlug: event.organisation.slug, eventId: event.event.id, rsvpId });
  if (!result.ok) return mobileActionError(result);
  const guest = await loadGuestAfterDecision(event, rsvpId);
  return guest ? mobileOk(guest) : notFound();
});
