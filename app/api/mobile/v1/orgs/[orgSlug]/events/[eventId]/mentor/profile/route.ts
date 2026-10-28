import { saveOwnMentorProfile } from "@/app/actions/mentor-console";
import { deskWrite, mentorRoute } from "@/lib/mobile/mentor";

/** Update this mentor's own profile `{ expectedVersion, skills?, bio?, affiliation?, availability?, maxActiveTeams?, showOnPage? }`. Needs an Idempotency-Key. */
export const PUT = mentorRoute<{ orgSlug: string; eventId: string }>("PUT /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/profile", async (request, { orgSlug, eventId }, context) =>
  deskWrite(request, context, "PUT /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/profile", { orgSlug, eventId }, saveOwnMentorProfile, {}));
