import { createOwnOfficeHourSlot } from "@/app/actions/mentor-console";
import { mobileError, mobileOk } from "@/lib/mobile/http";
import { deskWrite, mentorRoute } from "@/lib/mobile/mentor";
import { mentorSlots } from "@/lib/mobile/mentorReads";

/** This mentor's coming office-hour slots and who booked them (team names). */
export const GET = mentorRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/slots", async (_request, _params, { mentor }) => {
  const view = await mentorSlots(mentor);
  return view ? mobileOk(view) : mobileError("NOT_FOUND");
});

/** Open a slot `{ start, end, location?, capacity?, bookingDeadline? }` (event-local times) inside this mentor's availability. Needs an Idempotency-Key. */
export const POST = mentorRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/slots", async (request, { orgSlug, eventId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/slots", { orgSlug, eventId }, createOwnOfficeHourSlot, {}, 201));
