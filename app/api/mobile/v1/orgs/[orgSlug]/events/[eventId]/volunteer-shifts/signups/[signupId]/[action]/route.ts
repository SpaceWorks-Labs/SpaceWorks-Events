import { z } from "zod";
import { decideVolunteerSignup, recordVolunteerAttendance } from "@/app/actions/volunteer-shifts";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, parseJsonBody } from "@/lib/mobile/http";
import { loadRosterDto } from "@/lib/mobile/volunteers";

type Params = { orgSlug: string; eventId: string; signupId: string; action: string };
const DECISIONS = ["approve", "decline", "cancel"] as const;
const DESK = ["check-in", "check-out", "no-show"] as const;
/** The desk may enter an earlier time with a reason, and breaks at check-out. */
const bodySchema = z.object({ occurredAt: z.string().max(40).optional(), reason: z.string().max(500).optional(), breakMinutes: z.number().int().min(0).max(720).optional() }).strict();

/**
 * Approve, decline or cancel a sign-up, or the attendance desk: check-in,
 * check-out, no-show. Runs the Guests → Crew → Shifts actions (MANAGE_REGISTRATIONS, audited).
 */
export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/volunteer-shifts/signups/:signupId/:action", (permissions) => permissions.manageCrew, async (request, { signupId, action }, { auth, event }) => {
  const scope = { organisationSlug: event.organisation.slug, eventId: event.event.id, signupId };
  const decision = DECISIONS.find((value) => value === action);
  const desk = DESK.find((value) => value === action);
  if (!decision && !desk) return mobileError("NOT_FOUND");
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = decision ? await decideVolunteerSignup({ ...scope, decision }) : await recordVolunteerAttendance({ ...scope, action: desk, desk: body.data });
  if (!result.ok) return mobileActionError(result);
  return mobileOk(await loadRosterDto(event, auth.userId));
});
