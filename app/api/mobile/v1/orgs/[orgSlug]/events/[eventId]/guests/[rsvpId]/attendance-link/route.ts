import { issueAttendanceLinkForUser } from "@/lib/core/attendanceCheck";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk } from "@/lib/mobile/http";
import { attendanceLinkDtoSchema } from "@/lib/mobile/schemas";

type Params = { orgSlug: string; eventId: string; rsvpId: string };

/**
 * "Share attendance link" (docs/ATTENDANCE.md): one confirmed guest's
 * /attend link to send by hand, without an email. Owners and admins only
 * (`sendEmails`), until the event starts. Each call issues a new link that
 * replaces any earlier one; it is audited without the token.
 */
export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/guests/:rsvpId/attendance-link", (permissions) => permissions.sendEmails, async (_request, { rsvpId }, { auth, event, baseUrl }) => {
  const result = await issueAttendanceLinkForUser(auth.userId, { organisationSlug: event.organisation.slug, eventId: event.event.id, rsvpId });
  if (!result.ok || !result.data) return mobileActionError(result.ok ? { ok: false, error: "Could not create the link. Please try again." } : result);
  return mobileOk(attendanceLinkDtoSchema.parse({ url: `${baseUrl}${result.data.path}`, replaced: result.data.replaced }));
});
