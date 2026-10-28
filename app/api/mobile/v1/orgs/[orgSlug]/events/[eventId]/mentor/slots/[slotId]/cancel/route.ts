import { cancelOwnOfficeHourSlot } from "@/app/actions/mentor-console";
import { deskWrite, mentorRoute } from "@/lib/mobile/mentor";

/** Cancel one of this mentor's slots `{ expectedVersion, reason }`; teams are told. Needs an Idempotency-Key. */
export const POST = mentorRoute<{ orgSlug: string; eventId: string; slotId: string }>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/slots/:slotId/cancel", async (request, { orgSlug, eventId, slotId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/slots/:slotId/cancel", { orgSlug, eventId }, cancelOwnOfficeHourSlot, { slotId }));
