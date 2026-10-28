import { mobileError, mobileOk } from "@/lib/mobile/http";
import { participantRoute } from "@/lib/mobile/mentor";
import { participantDesk } from "@/lib/mobile/mentorReads";
import { participantHelpSchema } from "@/lib/mobile/schemas";

/** One of the team's own help requests with its comments; anyone else's is NOT_FOUND. */
export const GET = participantRoute<{ orgSlug: string; eventId: string; requestId: string }>("GET /api/mobile/v1/me/mentoring/:orgSlug/:eventId/help/:requestId", async (_request, { requestId }, { participant }) => {
  const request = (await participantDesk(participant))?.requests.find((row) => row.id === requestId);
  return request ? mobileOk(participantHelpSchema.parse(request)) : mobileError("NOT_FOUND");
});
