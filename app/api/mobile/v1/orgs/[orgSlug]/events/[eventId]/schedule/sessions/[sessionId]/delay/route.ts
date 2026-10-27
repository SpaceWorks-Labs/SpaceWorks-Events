import { z } from "zod";
import { setEventSessionDelayForUser } from "@/lib/core/eventProgramme";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk, parseJsonBody } from "@/lib/mobile/http";

type Params = { orgSlug: string; eventId: string; sessionId: string };
const bodySchema = z.object({ delayMinutes: z.number().int().min(0).max(1440) }).strict();

export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/schedule/sessions/:sessionId/delay", null, async (request, { sessionId }, { auth, event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await setEventSessionDelayForUser(auth.userId, { organisationSlug: event.organisation.slug, eventId: event.event.id, sessionId, delayMinutes: body.data.delayMinutes });
  if (!result.ok) return mobileActionError(result);
  return mobileOk(null);
});
