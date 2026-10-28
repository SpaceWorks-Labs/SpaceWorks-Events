import { z } from "zod";
import { decideVolunteerSignup, recordVolunteerAttendance } from "@/app/actions/volunteer-shifts";
import { prisma } from "@/lib/db";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, zodFieldErrors } from "@/lib/mobile/http";
import { idempotentWrite } from "@/lib/mobile/idempotency";
import { volunteerSignupWriteDtoSchema } from "@/lib/mobile/schemas";

type Params = { orgSlug: string; eventId: string; signupId: string; action: string };
const ROUTE = "POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/volunteer-shifts/signups/:signupId/:action";
const DECISIONS = ["approve", "decline", "cancel"] as const;
const DESK = ["check-in", "check-out", "no-show"] as const;
/** The desk may enter an earlier time with a reason, and breaks at check-out. */
const bodySchema = z.object({ occurredAt: z.string().max(40).optional(), reason: z.string().max(500).optional(), breakMinutes: z.number().int().min(0).max(720).optional() }).strict();

/**
 * Approve, decline or cancel a sign-up, or the attendance desk: check-in,
 * check-out, no-show. Runs the Guests → Crew → Shifts actions
 * (MANAGE_REGISTRATIONS, audited). Needs an Idempotency-Key, scoped to this
 * sign-up and action, so a retried desk tap never acts twice.
 */
export const POST = eventRoute<Params>(ROUTE, (permissions) => permissions.manageCrew, async (request, { signupId, action }, { auth, event }) => {
  const scope = { organisationSlug: event.organisation.slug, eventId: event.event.id, signupId };
  const decision = DECISIONS.find((value) => value === action);
  const desk = DESK.find((value) => value === action);
  if (!decision && !desk) return mobileError("NOT_FOUND");
  return idempotentWrite(request, auth.userId, `${ROUTE}:${event.event.id}:${signupId.slice(0, 64)}:${action}`, async (raw) => {
    const body = bodySchema.safeParse(raw ?? {});
    if (!body.success) return mobileError("INVALID_REQUEST", undefined, { fieldErrors: zodFieldErrors(body.error) });
    const result = decision ? await decideVolunteerSignup({ ...scope, decision }) : await recordVolunteerAttendance({ ...scope, action: desk, desk: body.data });
    if (!result.ok) return mobileActionError(result);
    const signup = await prisma.volunteerShiftSignup.findFirstOrThrow({ where: { id: signupId, eventId: event.event.id }, select: { id: true, status: true, attendance: true, hours: { select: { minutes: true } } } });
    return mobileOk(volunteerSignupWriteDtoSchema.parse({ signupId: signup.id, status: signup.status, attendance: signup.attendance, minutes: signup.hours?.minutes ?? null }));
  });
});
