import { recuseFromMyReview, resolveMobileReviewer } from "@/lib/mobile/admission";
import { mobileActionError, mobileOk, notFound } from "@/lib/mobile/http";
import { idempotentWrite } from "@/lib/mobile/idempotency";
import { authedMobileRoute } from "@/lib/mobile/route";

type Params = { orgSlug: string; eventId: string; assignmentId: string };
const ROUTE = "POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/applications/reviews/:assignmentId/recuse";

/**
 * Step back from an application not yet reviewed (a conflict of interest):
 * it is recorded, the caller is never given it again, and the reviewer with
 * the least work left on the stage's panel takes it (`replaced`). Needs an
 * Idempotency-Key, scoped to this assignment.
 */
export const POST = authedMobileRoute<Params>(ROUTE, async (request, { orgSlug, eventId, assignmentId }, { auth }) => {
  const ctx = await resolveMobileReviewer(auth.userId, orgSlug, eventId);
  if (!ctx) return notFound();
  return idempotentWrite(request, auth.userId, `${ROUTE}:${ctx.eventId}:${assignmentId.slice(0, 64)}`, async () => {
    const result = await recuseFromMyReview(ctx, assignmentId);
    return result.ok ? mobileOk(result.data) : mobileActionError(result);
  });
}, { staff: true });
