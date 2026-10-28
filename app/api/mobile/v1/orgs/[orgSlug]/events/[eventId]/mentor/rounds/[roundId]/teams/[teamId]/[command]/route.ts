import { mentorVisitCommand } from "@/app/actions/mentor-console";
import { mobileError } from "@/lib/mobile/http";
import { deskWrite, mentorRoute } from "@/lib/mobile/mentor";

/** App names for the visit commands; `check-in` submits the round's form for the team. */
const COMMANDS: Record<string, string> = { claim: "claim", heartbeat: "heartbeat", release: "release", "check-in": "submit" };

/**
 * A mentoring-round visit: claim the team (a lease), send `heartbeat` while
 * with them, `release` it, or `check-in` with `{ formVersion, answers, away?,
 * nominate? }`. Every command takes `expectedVersion`; heartbeat, release and
 * check-in also the `leaseId` and `generation` from the claim. Needs an
 * Idempotency-Key (heartbeats too: send a fresh key for each).
 */
export const POST = mentorRoute<{ orgSlug: string; eventId: string; roundId: string; teamId: string; command: string }>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/rounds/:roundId/teams/:teamId/:command", async (request, { orgSlug, eventId, roundId, teamId, command }, context) => {
  const action = COMMANDS[command];
  if (!action) return mobileError("NOT_FOUND");
  return deskWrite(request, context, `POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/rounds/:roundId/teams/:teamId/${command}`, { orgSlug, eventId }, mentorVisitCommand, { roundId, teamId, action });
});
