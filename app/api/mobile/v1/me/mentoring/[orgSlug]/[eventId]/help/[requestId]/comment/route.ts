import { commentOnHelpRequest } from "@/app/actions/mentor-help";
import { deskWrite, participantRoute } from "@/lib/mobile/mentor";

/** Comment on the team's request `{ expectedVersion, body }`. Needs an Idempotency-Key. */
export const POST = participantRoute<{ orgSlug: string; eventId: string; requestId: string }>("POST /api/mobile/v1/me/mentoring/:orgSlug/:eventId/help/:requestId/comment", async (request, { orgSlug, eventId, requestId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/me/mentoring/:orgSlug/:eventId/help/:requestId/comment", { orgSlug, eventId }, commentOnHelpRequest, { requestId }));
