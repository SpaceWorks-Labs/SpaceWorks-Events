import { mobileError, mobileOk } from "@/lib/mobile/http";
import { deskOrganiserRoute } from "@/lib/mobile/mentor";
import { deskQueue } from "@/lib/mobile/mentorReads";

/** Every help request of the event (organisation owners and admins), with mentors to assign: names, shift and load. */
export const GET = deskOrganiserRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor-desk/queue", async (_request, _params, { organiser }) => {
  const view = await deskQueue(organiser);
  return view ? mobileOk(view) : mobileError("NOT_FOUND");
});
