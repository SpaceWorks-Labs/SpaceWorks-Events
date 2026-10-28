import { z } from "zod";
import { prisma } from "@/lib/db";
import { saveFeedbackSettingsForUser } from "@/lib/core/feedbackSettings";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk, parseJsonBody } from "@/lib/mobile/http";
import { feedbackStateDtoSchema } from "@/lib/mobile/schemas";

const bodySchema = z.object({ open: z.boolean() }).strict();

/** Open or close the feedback form; every other setting is passed through unchanged to the shared save. */
export const POST = eventRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/feedback/state", null, async (request, _params, { auth, event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const current = await prisma.eventFeedbackForm.findUnique({
    where: { eventId: event.event.id },
    select: { title: true, thankYouMessage: true, certificateEnabled: true },
  });
  const result = await saveFeedbackSettingsForUser(auth.userId, {
    organisationSlug: event.organisation.slug,
    eventId: event.event.id,
    isOpen: body.data.open,
    title: current?.title ?? "Event feedback",
    thankYouMessage: current?.thankYouMessage ?? "Thanks for sharing your feedback.",
    certificateEnabled: current?.certificateEnabled ?? false,
  });
  if (!result.ok) return mobileActionError(result);
  return mobileOk(feedbackStateDtoSchema.parse({ open: body.data.open }));
});
