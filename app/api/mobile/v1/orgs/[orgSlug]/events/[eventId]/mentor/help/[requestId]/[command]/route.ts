import { mentorHelpCommand } from "@/app/actions/mentor-console";
import { mobileError } from "@/lib/mobile/http";
import { deskWrite, mentorRoute } from "@/lib/mobile/mentor";

const COMMANDS = new Set(["claim", "renew", "release", "resolve"]);

/**
 * Claim, renew, release or resolve a help request: `{ expectedVersion }`, and
 * for renew, release and resolve the held `claimId` and `claimGeneration`
 * (resolve and release may add a `note`). A claim is a lease: renew it before
 * `claimExpiresAt`. Two mentors claiming at once: one wins, the other gets
 * CONFLICT. Needs an Idempotency-Key.
 */
export const POST = mentorRoute<{ orgSlug: string; eventId: string; requestId: string; command: string }>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/help/:requestId/:command", async (request, { orgSlug, eventId, requestId, command }, context) => {
  if (!COMMANDS.has(command)) return mobileError("NOT_FOUND");
  return deskWrite(request, context, `POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/help/:requestId/${command}`, { orgSlug, eventId }, mentorHelpCommand, { requestId, action: command });
});
