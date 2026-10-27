import { deleteRsvpForUser } from "@/lib/core/rsvpAdmin";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, notFound } from "@/lib/mobile/http";
import { canSeeGuests, loadGuestDetail } from "@/lib/mobile/organiser";
import { undoDtoSchema } from "@/lib/mobile/schemas";

type Params = { orgSlug: string; eventId: string; rsvpId: string };

export const GET = eventRoute<Params>("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/guests/:rsvpId", canSeeGuests, async (_request, { rsvpId }, { event }) => {
  const guest = await loadGuestDetail(event, rsvpId);
  return guest ? mobileOk(guest) : notFound();
});

/** Delete with a five-minute undo, exactly as the dashboard (deleteRsvp). */
export const DELETE = eventRoute<Params>("DELETE /api/mobile/v1/orgs/:orgSlug/events/:eventId/guests/:rsvpId", null, async (_request, { rsvpId }, { auth, event }) => {
  const result = await deleteRsvpForUser(auth.userId, { organisationSlug: event.organisation.slug, eventId: event.event.id, rsvpId });
  if (!result.ok) return mobileActionError(result);
  if (!result.data) return mobileError("INTERNAL_ERROR");
  return mobileOk(undoDtoSchema.parse({ undoId: result.data.undoId }));
});
