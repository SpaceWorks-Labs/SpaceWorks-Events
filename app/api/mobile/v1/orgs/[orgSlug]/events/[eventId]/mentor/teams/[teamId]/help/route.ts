import { mentorRaiseHelp } from "@/app/actions/mentor-console";
import { deskWrite, mentorRoute } from "@/lib/mobile/mentor";

/** Raise help on a team's behalf `{ categoryKey, summary, location? }` (origin MENTOR; this mentor must be eligible for the team and category) → 201 `{ id }`. Needs an Idempotency-Key. */
export const POST = mentorRoute<{ orgSlug: string; eventId: string; teamId: string }>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/teams/:teamId/help", async (request, { orgSlug, eventId, teamId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/teams/:teamId/help", { orgSlug, eventId }, mentorRaiseHelp, { teamId }, 201));
