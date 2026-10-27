import { submitParticipantClaimAction } from "@/app/actions/participant-claims";
import { mobileActionError, mobileError, mobileOk, notFound } from "@/lib/mobile/http";
import { loadMyParticipantClaims, ownRegistration } from "@/lib/mobile/attendee";
import { authedMobileRoute } from "@/lib/mobile/route";

const MAX_BYTES = 16 * 1024 * 1024;

/** This registration's expense claims (travel grants), the cap and the categories; null when the event takes none. */
export const GET = authedMobileRoute<{ rsvpId: string }>("GET /api/mobile/v1/me/registrations/:rsvpId/claims", async (_request, { rsvpId }, { auth }) => {
  const claims = await loadMyParticipantClaims(auth.userId, rsvpId);
  return claims === undefined ? notFound() : mobileOk(claims);
});

/**
 * File a claim: multipart form with `category`, `description`, `amount` and
 * up to three `receipts` photos, exactly as the ticket page. Receipts are
 * re-encoded and stored privately.
 */
export const POST = authedMobileRoute<{ rsvpId: string }>("POST /api/mobile/v1/me/registrations/:rsvpId/claims", async (request, { rsvpId }, { auth }) => {
  const rsvp = await ownRegistration(auth.userId, rsvpId);
  if (!rsvp) return notFound();
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) return mobileError("INVALID_REQUEST", "Request is too large.");
  const form = await request.formData().catch(() => null);
  if (!form) return mobileError("INVALID_REQUEST", "Send the claim as a multipart form.");
  const fields = new FormData();
  fields.set("ticketToken", rsvp.checkInToken);
  for (const name of ["category", "description", "amount"]) fields.set(name, String(form.get(name) ?? ""));
  for (const file of form.getAll("receipts")) if (file instanceof File) fields.append("receipts", file);
  const result = await submitParticipantClaimAction(fields);
  if (!result.ok) return mobileActionError(result);
  return mobileOk(await loadMyParticipantClaims(auth.userId, rsvpId), 201);
});
