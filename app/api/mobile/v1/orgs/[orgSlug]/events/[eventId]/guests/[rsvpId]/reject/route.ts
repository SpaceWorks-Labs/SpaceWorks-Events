import { rejectRsvpForUser } from "@/lib/core/rsvpLifecycle";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk, notFound } from "@/lib/mobile/http";
import { loadGuest, loadGuestAfterDecision } from "@/lib/mobile/organiser";

type Params = { orgSlug: string; eventId: string; rsvpId: string };

/**
 * Same capacity transaction, notification email and audit as the dashboard. A
 * declined paid request is cancelled with its order (its places removed) and
 * an approved paid order is refunded (paymentOutcome REFUNDED).
 */
export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/guests/:rsvpId/reject", null, async (_request, { rsvpId }, { auth, event }) => {
  const before = await loadGuest(event, rsvpId);
  if (!before) return notFound();
  const result = await rejectRsvpForUser(auth.userId, { organisationSlug: event.organisation.slug, eventId: event.event.id, rsvpId });
  if (!result.ok) return mobileActionError(result);
  const guest = await loadGuestAfterDecision(event, rsvpId);
  return mobileOk(guest ?? { ...before, status: "REJECTED" as const });
});
