import { withdrawParticipantClaimAction } from "@/app/actions/participant-claims";
import { mobileActionError, mobileOk, notFound } from "@/lib/mobile/http";
import { loadMyParticipantClaims, ownRegistration } from "@/lib/mobile/attendee";
import { authedMobileRoute } from "@/lib/mobile/route";

/** Withdraw one of this registration's claims before it is decided. */
export const POST = authedMobileRoute<{ rsvpId: string; claimId: string }>("POST /api/mobile/v1/me/registrations/:rsvpId/claims/:claimId/withdraw", async (_request, { rsvpId, claimId }, { auth }) => {
  const rsvp = await ownRegistration(auth.userId, rsvpId);
  if (!rsvp) return notFound();
  const result = await withdrawParticipantClaimAction(rsvp.checkInToken, claimId);
  if (!result.ok) return mobileActionError(result);
  return mobileOk(await loadMyParticipantClaims(auth.userId, rsvpId));
});
