import { prisma } from "@/lib/db";
import { cancelRsvpForUser } from "@/lib/core/rsvpCancel";
import { mobileActionError, mobileOk, notFound } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";

export const POST = authedMobileRoute<{ rsvpId: string }>("POST /api/mobile/v1/me/registrations/:rsvpId/cancel", async (_request, { rsvpId }, { auth }) => {
  if (!rsvpId || rsvpId.length > 128) return notFound();
  // Only the caller's own RSVP is addressable; anyone else's is NOT_FOUND.
  const rsvp = await prisma.rSVP.findFirst({ where: { id: rsvpId, userId: auth.userId }, select: { id: true } });
  if (!rsvp) return notFound();
  // A paid ticket refuses with PAID_ORDER: cancel its order (POST /me/orders/:orderId/cancel) under the refund policy.
  const result = await cancelRsvpForUser(auth.userId, { rsvpId: rsvp.id });
  if (!result.ok) return mobileActionError(result);
  return mobileOk(null);
});
