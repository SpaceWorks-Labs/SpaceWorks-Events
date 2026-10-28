import "server-only";

import { approveTeam, promoteTeam, rejectTeam } from "@/app/actions/team-admin";
import { forUser } from "./actor";

/* Whole-team decisions for API callers, by the dashboard's action bodies (paid team places are refunded on rejection). */
export function transitionTeamStatusForUser(actorUserId: string | null, input: { organisationSlug: string; eventId: string; teamId: string; }, action: "approve" | "reject" | "promote") {
  const run = action === "approve" ? approveTeam : action === "reject" ? rejectTeam : promoteTeam;
  return forUser(actorUserId, () => run(input));
}
