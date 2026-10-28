import { rescheduleOwnOfficeHourSlot } from "@/app/actions/mentor-console";
import { deskWrite, mentorRoute } from "@/lib/mobile/mentor";

/** Move one of this mentor's slots `{ expectedVersion, start, end, reason, ... }`. Needs an Idempotency-Key. */
export const POST = mentorRoute<{ orgSlug: string; eventId: string; slotId: string }>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/slots/:slotId/reschedule", async (request, { orgSlug, eventId, slotId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/slots/:slotId/reschedule", { orgSlug, eventId }, rescheduleOwnOfficeHourSlot, { slotId }));
