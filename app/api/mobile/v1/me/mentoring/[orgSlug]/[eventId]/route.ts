import { mobileError, mobileOk } from "@/lib/mobile/http";
import { participantRoute } from "@/lib/mobile/mentor";
import { participantDesk } from "@/lib/mobile/mentorReads";

/**
 * The participant's Mentor Desk: help categories, the team's (or solo
 * registrant's) own requests with their comments, public mentor profiles,
 * office-hour slots that can be booked and the team's bookings.
 */
export const GET = participantRoute("GET /api/mobile/v1/me/mentoring/:orgSlug/:eventId/", async (_request, _params, { participant }) => {
  const desk = await participantDesk(participant);
  return desk ? mobileOk(desk) : mobileError("NOT_FOUND");
});
