import { mobileOk, notFound } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";
import { loadMyShiftsDto, ownCrewTicket } from "@/lib/mobile/volunteers";

/** The caller's volunteer shifts on their own crew ticket (docs/VOLUNTEERS.md); null when the event has no shifts on. */
export const GET = authedMobileRoute<{ rsvpId: string }>("GET /api/mobile/v1/me/registrations/:rsvpId/shifts", async (_request, { rsvpId }, { auth, baseUrl }) => {
  const rsvp = await ownCrewTicket(auth.userId, rsvpId);
  return rsvp ? mobileOk(await loadMyShiftsDto(rsvp, baseUrl)) : notFound();
});
