import { organiserHelpCommand } from "@/app/actions/mentor-desk";
import { deskWrite, deskOrganiserRoute } from "@/lib/mobile/mentor";

/** Put a claimed request back in the queue `{ expectedVersion, note? }`. Needs an Idempotency-Key. */
export const POST = deskOrganiserRoute<{ orgSlug: string; eventId: string; requestId: string }>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor-desk/help/:requestId/reopen", async (request, { orgSlug, eventId, requestId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor-desk/help/:requestId/reopen", { orgSlug, eventId }, organiserHelpCommand, { requestId, action: "reopen" }));
