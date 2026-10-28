import { raiseHelpRequest } from "@/app/actions/mentor-help";
import { deskWrite, participantRoute } from "@/lib/mobile/mentor";

/** Raise a help request `{ categoryKey, summary, location? }` for the team (or solo registration). Needs an Idempotency-Key. */
export const POST = participantRoute<{ orgSlug: string; eventId: string }>("POST /api/mobile/v1/me/mentoring/:orgSlug/:eventId/help", async (request, { orgSlug, eventId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/me/mentoring/:orgSlug/:eventId/help", { orgSlug, eventId }, raiseHelpRequest, {}, 201));
