import { z } from "zod";
import { sendEventBroadcastTestForUser } from "@/lib/core/broadcasts";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, readJsonBody } from "@/lib/mobile/http";
import { broadcastTestDtoSchema } from "@/lib/mobile/schemas";

const bodySchema = z.object({ subject: z.unknown(), body: z.unknown(), design: z.unknown().optional() }).strict();

export const POST = eventRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/broadcasts/test", null, async (request, _params, { auth, event }) => {
  const body = await readJsonBody(request);
  if ("response" in body) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return mobileError("INVALID_REQUEST");
  const result = await sendEventBroadcastTestForUser(auth.userId, { ...parsed.data, organisationSlug: event.organisation.slug, eventId: event.event.id });
  if (!result.ok) return mobileActionError(result);
  return result.data ? mobileOk(broadcastTestDtoSchema.parse(result.data)) : mobileError("INTERNAL_ERROR");
});
