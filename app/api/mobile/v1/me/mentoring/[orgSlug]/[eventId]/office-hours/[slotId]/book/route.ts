import { bookOfficeHourAction } from "@/app/actions/mentor-help";
import { deskWrite, participantRoute } from "@/lib/mobile/mentor";

/** Book an office-hour slot for the team `{ expectedVersion }`. Needs an Idempotency-Key. */
export const POST = participantRoute<{ orgSlug: string; eventId: string; slotId: string }>("POST /api/mobile/v1/me/mentoring/:orgSlug/:eventId/office-hours/:slotId/book", async (request, { orgSlug, eventId, slotId }, context) =>
  deskWrite(request, context, "POST /api/mobile/v1/me/mentoring/:orgSlug/:eventId/office-hours/:slotId/book", { orgSlug, eventId }, bookOfficeHourAction, { slotId }, 201));
