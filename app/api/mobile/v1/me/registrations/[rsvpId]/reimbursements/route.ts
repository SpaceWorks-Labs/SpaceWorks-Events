import { loadMyReimbursements } from "@/lib/mobile/attendee";
import { mobileOk, notFound } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";

/**
 * The reimbursement policies this registration may claim under now, each
 * with what is left for the caller, and whether general claims are open;
 * null when there is nothing to claim (docs/FINANCE.md). File a claim under
 * one with `policyId` on POST …/claims.
 */
export const GET = authedMobileRoute<{ rsvpId: string }>("GET /api/mobile/v1/me/registrations/:rsvpId/reimbursements", async (_request, { rsvpId }, { auth }) => {
  const reimbursements = await loadMyReimbursements(auth.userId, rsvpId);
  return reimbursements === undefined ? notFound() : mobileOk(reimbursements);
});
