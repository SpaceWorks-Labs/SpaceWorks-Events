import { loadReviewQueue, resolveMobileReviewer } from "@/lib/mobile/admission";
import { mobileOk, notFound } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";

type Params = { orgSlug: string; eventId: string };

/**
 * The caller's review assignments on this event (docs/ADMISSION.md
 * "Reviewing"), open stages first, as the web review workspace lists them.
 * Reviewers only (REVIEW_APPLICATIONS or owner/admin), behind the staff
 * authenticator; anyone else, or an event not taking applications, is NOT_FOUND.
 */
export const GET = authedMobileRoute<Params>("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/applications/reviews", async (_request, { orgSlug, eventId }, { auth }) => {
  const ctx = await resolveMobileReviewer(auth.userId, orgSlug, eventId);
  return ctx ? mobileOk(await loadReviewQueue(ctx)) : notFound();
}, { staff: true });
