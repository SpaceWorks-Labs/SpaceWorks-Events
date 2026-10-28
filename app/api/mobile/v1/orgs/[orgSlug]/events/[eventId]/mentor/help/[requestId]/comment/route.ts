import { mentorCommentOnHelp } from "@/app/actions/mentor-console";
import { deskWrite, mentorRoute } from "@/lib/mobile/mentor";

/** Comment on the request this mentor holds `{ expectedVersion, body }`. Needs an Idempotency-Key. */
export const POST = mentorRoute<{ orgSlug: string; eventId: string; requestId: string }>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/help/:requestId/comment", async (request, { orgSlug, eventId, requestId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/help/:requestId/comment", { orgSlug, eventId }, mentorCommentOnHelp, { requestId }));
