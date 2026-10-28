import crypto from "node:crypto";
import { z } from "zod";
import { syncOfflineCheckInsForUser } from "@/lib/core/checkin";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, parseJsonBody } from "@/lib/mobile/http";
import { syncDtoSchema } from "@/lib/mobile/schemas";

const bodySchema = z.object({
  checkIns: z.array(z.object({
    rsvpId: z.string().min(1).max(128),
    checkedInAt: z.string().datetime(),
    force: z.boolean().default(false),
    clientMutationId: z.string().min(8).max(128).optional(),
  }).strict()).min(1).max(500),
}).strict();

/** Same operating-window and eligibility rules as the web offline sync. */
export const POST = eventRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/check-in/sync", null, async (request, _params, { auth, event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await syncOfflineCheckInsForUser(auth.userId, {
    organisationSlug: event.organisation.slug,
    eventId: event.event.id,
    checkIns: body.data.checkIns.map((entry) => ({ ...entry, clientMutationId: entry.clientMutationId ?? crypto.randomUUID() })),
  });
  if (!result.ok) return mobileActionError(result);
  return result.data ? mobileOk(syncDtoSchema.parse(result.data)) : mobileError("INTERNAL_ERROR");
});
