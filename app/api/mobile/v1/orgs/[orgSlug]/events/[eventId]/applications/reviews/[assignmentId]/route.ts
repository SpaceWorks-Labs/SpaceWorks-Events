import { z } from "zod";
import { loadReview, resolveMobileReviewer, submitMyReview } from "@/lib/mobile/admission";
import { mobileActionError, mobileError, mobileOk, notFound, zodFieldErrors } from "@/lib/mobile/http";
import { idempotentWrite } from "@/lib/mobile/idempotency";
import { authedMobileRoute } from "@/lib/mobile/route";

type Params = { orgSlug: string; eventId: string; assignmentId: string };
const POST_ROUTE = "POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/applications/reviews/:assignmentId";
const bodySchema = z.object({ answersRevision: z.number().int().min(1), scores: z.record(z.string().max(60), z.number()), notes: z.string().max(2000) }).strict();

/**
 * One assigned application, as the stage allows: a blind stage shows no
 * names, email addresses, phone numbers or team name. Someone else's
 * assignment, one the caller stepped back from, or one they may no longer
 * review (off the panel, a conflict) is NOT_FOUND.
 */
export const GET = authedMobileRoute<Params>("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/applications/reviews/:assignmentId", async (_request, { orgSlug, eventId, assignmentId }, { auth }) => {
  const ctx = await resolveMobileReviewer(auth.userId, orgSlug, eventId);
  const item = ctx ? await loadReview(ctx, assignmentId) : null;
  return item ? mobileOk(item) : notFound();
}, { staff: true });

/**
 * Submit the review: every criterion scored 1 to 5 and optional notes for
 * the organisers. Reviews are final once submitted. Only while the stage is
 * open and the application is in review there. `answersRevision` is the
 * one GET returned: answers changed since are CONFLICT ("The answers
 * changed. Reload to see them."), and the reloaded submission needs a new
 * Idempotency-Key, scoped to this assignment.
 */
export const POST = authedMobileRoute<Params>(POST_ROUTE, async (request, { orgSlug, eventId, assignmentId }, { auth }) => {
  const ctx = await resolveMobileReviewer(auth.userId, orgSlug, eventId);
  if (!ctx) return notFound();
  return idempotentWrite(request, auth.userId, `${POST_ROUTE}:${ctx.eventId}:${assignmentId.slice(0, 64)}`, async (raw) => {
    const body = bodySchema.safeParse(raw ?? {});
    if (!body.success) return mobileError("INVALID_REQUEST", undefined, { fieldErrors: zodFieldErrors(body.error) });
    const result = await submitMyReview(ctx, assignmentId, body.data);
    return result.ok ? mobileOk(result.data) : mobileActionError(result);
  });
}, { staff: true });
