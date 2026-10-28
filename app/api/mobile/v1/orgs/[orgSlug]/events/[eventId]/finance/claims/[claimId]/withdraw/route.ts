import { withdrawStaffClaimAction } from "@/app/actions/finance";
import { loadMyStaffClaims } from "@/lib/mobile/attendee";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk } from "@/lib/mobile/http";

type Params = { orgSlug: string; eventId: string; claimId: string };

/** Withdraw one of the caller's own claims before it is decided. */
export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/finance/claims/:claimId/withdraw", (permissions) => permissions.fileClaims, async (_request, { claimId }, { auth, event }) => {
  const result = await withdrawStaffClaimAction({ organisationSlug: event.organisation.slug, eventId: event.event.id }, claimId);
  if (!result.ok) return mobileActionError(result);
  return mobileOk(await loadMyStaffClaims(auth.userId, event.event.id));
}, { idempotent: true, anyGrant: true });
