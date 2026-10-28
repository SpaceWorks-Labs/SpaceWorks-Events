import { declareMentorConflict } from "@/app/actions/mentor-console";
import { deskWrite, mentorRoute } from "@/lib/mobile/mentor";

/**
 * Declare or clear this mentor's own conflict with a team `{ active,
 * expectedVersion, reason? }` (0 for a new one; the live row's version to
 * change or clear it). Only DECLARED conflicts this mentor recorded. Needs an Idempotency-Key.
 */
export const POST = mentorRoute<{ orgSlug: string; eventId: string; teamId: string }>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/teams/:teamId/conflict", async (request, { orgSlug, eventId, teamId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/teams/:teamId/conflict", { orgSlug, eventId }, declareMentorConflict, { teamId, kind: "DECLARED" }));
