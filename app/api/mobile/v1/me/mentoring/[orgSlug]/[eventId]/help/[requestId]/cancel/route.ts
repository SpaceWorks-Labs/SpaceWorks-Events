import { cancelHelpRequest } from "@/app/actions/mentor-help";
import { deskWrite, participantRoute } from "@/lib/mobile/mentor";

/** Cancel the team's open request `{ expectedVersion }`. Needs an Idempotency-Key. */
export const POST = participantRoute<{ orgSlug: string; eventId: string; requestId: string }>("POST /api/mobile/v1/me/mentoring/:orgSlug/:eventId/help/:requestId/cancel", async (request, { orgSlug, eventId, requestId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/me/mentoring/:orgSlug/:eventId/help/:requestId/cancel", { orgSlug, eventId }, cancelHelpRequest, { requestId }));
