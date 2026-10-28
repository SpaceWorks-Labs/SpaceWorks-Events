import { myShiftAction } from "@/app/actions/my-shifts";
import { mobileActionError, mobileOk, notFound } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";
import { loadMyShiftsDto, ownCrewTicket } from "@/lib/mobile/volunteers";

const ACTIONS = ["apply", "withdraw", "check-in", "check-out"] as const;
type Params = { rsvpId: string; id: string; action: string };

/**
 * A crew member acts on their own shifts: `apply` takes a shift id; `withdraw`,
 * `check-in` and `check-out` take one of their sign-up ids. Runs the crew
 * ticket's own action (rate limited per ticket, audited) and returns their shifts.
 */
export const POST = authedMobileRoute<Params>("POST /api/mobile/v1/me/registrations/:rsvpId/shifts/:id/:action", async (_request, { rsvpId, id, action }, { auth, baseUrl }) => {
  const known = ACTIONS.find((value) => value === action);
  const rsvp = known ? await ownCrewTicket(auth.userId, rsvpId) : null;
  if (!known || !rsvp) return notFound();
  const result = await myShiftAction({ ticketToken: rsvp.checkInToken, action: known, id: id.slice(0, 64) });
  if (!result.ok) return mobileActionError(result);
  return mobileOk(await loadMyShiftsDto(rsvp, baseUrl));
});
