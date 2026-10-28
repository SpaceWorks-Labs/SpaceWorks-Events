import { mobileError, mobileOk } from "@/lib/mobile/http";
import { mentorRoute } from "@/lib/mobile/mentor";
import { mentorTeams } from "@/lib/mobile/mentorReads";

/** Teams assigned to this mentor and their declared conflicts: team names only. */
export const GET = mentorRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/teams", async (_request, _params, { mentor }) => {
  const view = await mentorTeams(mentor);
  return view ? mobileOk(view) : mobileError("NOT_FOUND");
});
