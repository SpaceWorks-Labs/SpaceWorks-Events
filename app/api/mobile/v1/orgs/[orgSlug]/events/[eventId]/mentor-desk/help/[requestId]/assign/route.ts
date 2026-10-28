import { organiserHelpCommand } from "@/app/actions/mentor-desk";
import { deskOrganiserRoute, deskWrite } from "@/lib/mobile/mentor";

/** Hand a request to a mentor `{ expectedVersion, mentorUserId, note? }`. Needs an Idempotency-Key. */
export const POST = deskOrganiserRoute<{ orgSlug: string; eventId: string; requestId: string }>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor-desk/help/:requestId/assign", async (request, { orgSlug, eventId, requestId }, context) => {
  return deskWrite(request, context, "POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor-desk/help/:requestId/assign", { orgSlug, eventId }, organiserHelpCommand, { requestId, action: "assign" }, 200, ["mentorUserId"]);
});
