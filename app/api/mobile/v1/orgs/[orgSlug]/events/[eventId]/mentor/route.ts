import { mobileError, mobileOk } from "@/lib/mobile/http";
import { mentorRoute } from "@/lib/mobile/mentor";
import { mentorConsole } from "@/lib/mobile/mentorReads";

/**
 * The mentor console: profile and shift, the request this mentor holds (with
 * its comments and claim ids), the queue size, categories and the live
 * mentoring round's board with this mentor's own visit leases.
 */
export const GET = mentorRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/", async (_request, _params, { mentor }) => {
  const view = await mentorConsole(mentor);
  return view ? mobileOk(view) : mobileError("NOT_FOUND");
});
