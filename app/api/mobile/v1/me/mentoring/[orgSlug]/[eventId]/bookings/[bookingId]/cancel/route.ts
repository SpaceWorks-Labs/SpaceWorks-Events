import { cancelOfficeHourBookingAction } from "@/app/actions/mentor-help";
import { deskWrite, participantRoute } from "@/lib/mobile/mentor";

/** Cancel one of the team's office-hour bookings. Needs an Idempotency-Key. */
export const POST = participantRoute<{ orgSlug: string; eventId: string; bookingId: string }>("POST /api/mobile/v1/me/mentoring/:orgSlug/:eventId/bookings/:bookingId/cancel", async (request, { orgSlug, eventId, bookingId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/me/mentoring/:orgSlug/:eventId/bookings/:bookingId/cancel", { orgSlug, eventId }, cancelOfficeHourBookingAction, { bookingId }));
