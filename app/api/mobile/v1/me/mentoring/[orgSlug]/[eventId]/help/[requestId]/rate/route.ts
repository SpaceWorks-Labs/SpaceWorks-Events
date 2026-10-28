import { rateHelpRequest } from "@/app/actions/mentor-help";
import { deskWrite, participantRoute } from "@/lib/mobile/mentor";

/** Rate a resolved request `{ rating }` (1 to 5). Needs an Idempotency-Key. */
export const POST = participantRoute<{ orgSlug: string; eventId: string; requestId: string }>("POST /api/mobile/v1/me/mentoring/:orgSlug/:eventId/help/:requestId/rate", async (request, { orgSlug, eventId, requestId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/me/mentoring/:orgSlug/:eventId/help/:requestId/rate", { orgSlug, eventId }, rateHelpRequest, { requestId }));
