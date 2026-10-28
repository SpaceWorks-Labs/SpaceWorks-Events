import "server-only";

import type { ActionResult } from "@/app/actions/org";
import { cancelRsvp } from "@/app/actions/rsvp-cancel";
import { prisma } from "@/lib/db";
import { forUser } from "./actor";

/**
 * A signed-in attendee cancels their own registration by id, through the
 * website's cancellation body: a collected payment refuses (PAID_ORDER; the
 * order's refund policy applies), a paid request is withdrawn, a held order
 * is released, waitlists fill and teams settle. The ticket token is looked up
 * here only to drive that body and is never returned.
 */
export async function cancelRsvpForUser(actorUserId: string | null, input: { rsvpId: string; }): Promise<ActionResult<{ cancelled: true; }>> {
  return forUser(actorUserId, async () => {
    const rsvp = await prisma.rSVP.findFirst({ where: { id: input.rsvpId, userId: actorUserId! }, select: { checkInToken: true } });
    if (!rsvp) return { ok: false, error: "RSVP not found." };
    return cancelRsvp({ checkInToken: rsvp.checkInToken });
  });
}
