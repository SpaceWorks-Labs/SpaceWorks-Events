import { loadMyApplication } from "@/lib/mobile/admission";
import { mobileOk, notFound } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";

type Params = { rsvpId: string };

/**
 * The caller's own application (docs/ADMISSION.md): status, stage, the
 * offer's answer-by time, what they may do now, payment state, and their
 * answers while still editable. `{ application: null }` when the registration
 * isn't an application; anyone else's registration is NOT_FOUND. No ticket
 * token, reviews or scores.
 */
export const GET = authedMobileRoute<Params>("GET /api/mobile/v1/me/registrations/:rsvpId/application", async (_request, { rsvpId }, { auth }) => {
  const result = await loadMyApplication(auth.userId, rsvpId);
  return result ? mobileOk(result) : notFound();
});
