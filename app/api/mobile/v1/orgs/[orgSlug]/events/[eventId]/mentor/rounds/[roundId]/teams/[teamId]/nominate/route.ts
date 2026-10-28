import { nominateTeamAction } from "@/app/actions/mentor-console";
import { deskWrite, mentorRoute } from "@/lib/mobile/mentor";

/** Nominate a team you checked in with this round (a private shortlist, never part of judging scores). Needs an Idempotency-Key. */
export const POST = mentorRoute<{ orgSlug: string; eventId: string; roundId: string; teamId: string }>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/rounds/:roundId/teams/:teamId/nominate", async (request, { orgSlug, eventId, roundId, teamId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/rounds/:roundId/teams/:teamId/nominate", { orgSlug, eventId }, nominateTeamAction, { roundId, teamId }));
