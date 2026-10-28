import { z } from "zod";
import { reviewVolunteerHours } from "@/app/actions/volunteer-shifts";
import { prisma } from "@/lib/db";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, zodFieldErrors } from "@/lib/mobile/http";
import { idempotentWrite } from "@/lib/mobile/idempotency";
import { volunteerHoursWriteDtoSchema } from "@/lib/mobile/schemas";

type Params = { orgSlug: string; eventId: string; hoursId: string; action: string };
const ROUTE = "POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/volunteer-shifts/hours/:hoursId/:action";
const bodySchema = z.object({ minutes: z.number().int().min(0).max(1440).optional(), reason: z.string().max(500).optional() }).strict();

/**
 * Verify pending hours, or adjust verified ones (`minutes` and `reason`).
 * Organisation owners and admins only, never their own hours (a second
 * person). Needs an Idempotency-Key, scoped to these hours and the action.
 */
export const POST = eventRoute<Params>(ROUTE, (permissions) => permissions.manageCrew && permissions.manageFinance, async (request, { hoursId, action }, { auth, event }) => {
  if (action !== "verify" && action !== "adjust") return mobileError("NOT_FOUND");
  return idempotentWrite(request, auth.userId, `${ROUTE}:${event.event.id}:${hoursId.slice(0, 64)}:${action}`, async (raw) => {
    const body = bodySchema.safeParse(raw ?? {});
    if (!body.success) return mobileError("INVALID_REQUEST", undefined, { fieldErrors: zodFieldErrors(body.error) });
    const result = await reviewVolunteerHours({ organisationSlug: event.organisation.slug, eventId: event.event.id, hoursId, action, ...body.data });
    if (!result.ok) return mobileActionError(result);
    const hours = await prisma.volunteerHours.findFirstOrThrow({ where: { id: hoursId, eventId: event.event.id }, select: { id: true, state: true, minutes: true } });
    return mobileOk(volunteerHoursWriteDtoSchema.parse({ hoursId: hours.id, state: hours.state, minutes: hours.minutes, revokedCertificate: result.data?.revokedCertificate ?? false }));
  });
});
