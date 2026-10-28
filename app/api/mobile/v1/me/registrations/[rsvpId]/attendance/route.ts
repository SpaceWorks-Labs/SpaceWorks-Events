import { respondToAttendanceCheckForUser } from "@/lib/core/attendanceCheck";
import { loadMyAttendance } from "@/lib/mobile/attendance";
import { mobileActionError, mobileOk, notFound, readJsonBody } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";
import { attendanceReplyDtoSchema } from "@/lib/mobile/schemas";

type Params = { rsvpId: string };

/**
 * "Are you still coming?" for the caller's own registration
 * (docs/ATTENDANCE.md): `{ attendance: null }` when they were never asked.
 * Anyone else's registration is NOT_FOUND. The link token is never returned.
 */
export const GET = authedMobileRoute<Params>("GET /api/mobile/v1/me/registrations/:rsvpId/attendance", async (_request, { rsvpId }, { auth }) => {
  const result = await loadMyAttendance(auth.userId, rsvpId);
  return result ? mobileOk(result) : notFound();
});

/**
 * Answer it, with the same rules as /attend/{token}: open until the event
 * starts, Yes or No with a note of up to 500 characters, and with "Free the
 * place when a guest says No" on, the same release (or kept paid place) as
 * the web form.
 */
export const POST = authedMobileRoute<Params>("POST /api/mobile/v1/me/registrations/:rsvpId/attendance", async (request, { rsvpId }, { auth }) => {
  const mine = await loadMyAttendance(auth.userId, rsvpId);
  if (!mine?.attendance) return notFound();
  const body = await readJsonBody(request);
  if ("response" in body) return body.response;
  const result = await respondToAttendanceCheckForUser(auth.userId, rsvpId, body.value);
  if (!result.ok || !result.data) return mobileActionError(result.ok ? { ok: false, error: "This link is no longer valid." } : result);
  return mobileOk(attendanceReplyDtoSchema.parse({ response: result.data.response, released: result.data.released, releaseFailed: result.data.releaseFailed ?? null }));
}, { idempotent: true });
