import { z } from "zod";
import { setRegistrationWindowForUser } from "@/lib/core/registrationWindow";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, parseJsonBody } from "@/lib/mobile/http";
import { registrationStateDtoSchema } from "@/lib/mobile/schemas";

const bodySchema = z.object({ open: z.boolean() }).strict();

export const POST = eventRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/registration/state", null, async (request, _params, { auth, event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await setRegistrationWindowForUser(auth.userId, { organisationSlug: event.organisation.slug, eventId: event.event.id, open: body.data.open });
  if (!result.ok) return mobileActionError(result);
  return result.data ? mobileOk(registrationStateDtoSchema.parse(result.data)) : mobileError("INTERNAL_ERROR");
});
