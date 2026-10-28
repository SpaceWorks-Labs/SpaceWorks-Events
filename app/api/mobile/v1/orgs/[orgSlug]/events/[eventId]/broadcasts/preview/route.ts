import { z } from "zod";
import { previewEventBroadcastForUser } from "@/lib/core/broadcasts";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, readJsonBody } from "@/lib/mobile/http";
import { broadcastPreviewDtoSchema } from "@/lib/mobile/schemas";

const bodySchema = z.object({ subject: z.unknown(), body: z.unknown(), design: z.unknown().optional() }).strict();

/** Server-rendered email. Images use absolute URLs so the app's WebView (JavaScript disabled) can load them. */
export const POST = eventRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/broadcasts/preview", null, async (request, _params, { auth, event }) => {
  const body = await readJsonBody(request);
  if ("response" in body) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return mobileError("INVALID_REQUEST");
  const result = await previewEventBroadcastForUser(auth.userId, { ...parsed.data, organisationSlug: event.organisation.slug, eventId: event.event.id });
  if (!result.ok) return mobileActionError(result);
  return result.data ? mobileOk(broadcastPreviewDtoSchema.parse({ subject: result.data.subject, html: result.data.html, text: result.data.text })) : mobileError("INTERNAL_ERROR");
});
