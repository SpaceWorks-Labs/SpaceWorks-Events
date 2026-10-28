import { RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { PaymentOperationError, reacceptDeclinedOrder } from "@/lib/payments/operations";
import { confirmRsvpWithinCapacity } from "@/lib/rsvpCapacity";
import { rsvpTransitionSchema } from "@/lib/validators";
import type { ActionResult } from "../org";
import { flattenZodErrors } from "../utils";
import { attendeeEmail, loadRsvpContext, revalidateRsvpPaths } from "./helpers";

/** CONFIRMED or WAITLISTED for a free registration; a paid one is sent a payment link (PAYMENT_REQUESTED) or waitlisted. */
export type ReacceptStatus = "CONFIRMED" | "WAITLISTED" | "PAYMENT_REQUESTED";

/**
 * Reverses a decline, with the same permission as approving. A free
 * registration goes through the same locked capacity transaction as an
 * approval (the event or date must still be open): confirmed when there is
 * room, otherwise waitlisted, never oversold. A paid one goes back through
 * the payment flow instead (lib/payments/operations/reaccept.ts) and is
 * confirmed only once it is paid.
 */
export async function reacceptRsvpFor(userId: string, input: unknown): Promise<ActionResult<{ status: ReacceptStatus; }>> {
  if (await isActionRateLimited("rsvp", userId)) return { ok: false, error: "Too many attendee updates. Try again shortly." };
  const parsed = rsvpTransitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input.", fieldErrors: flattenZodErrors(parsed.error) };

  const { organisationSlug, rsvpId, eventId, eventInstanceId } = parsed.data;
  const ctx = await loadRsvpContext(organisationSlug, userId, rsvpId, eventId, eventInstanceId);
  if ("error" in ctx && ctx.error) return { ok: false, error: ctx.error, ...("code" in ctx && ctx.code ? { code: ctx.code } : {}) };
  if (!("rsvp" in ctx)) return { ok: false, error: "Invalid state." };
  const { org, rsvp } = ctx;
  if (rsvp.status !== RsvpStatus.REJECTED) return { ok: false, error: "Only declined registrations can be re-accepted." };
  const paths = ctx.event ? { orgSlug: org.slug, eventSlug: ctx.event.slug, eventId: ctx.event.id } : { orgSlug: org.slug, eventInstanceId: ctx.instance!.id };

  const order = rsvp.orderId ? await prisma.order.findUnique({ where: { id: rsvp.orderId }, select: { id: true, totalMinor: true } }) : null;
  let status: ReacceptStatus;
  if (order && order.totalMinor > BigInt(0)) {
    try {
      const outcome = await reacceptDeclinedOrder({ orderId: order.id, organisationId: org.id, actorUserId: userId });
      status = outcome === "offered" ? "PAYMENT_REQUESTED" : "WAITLISTED";
    } catch (error) {
      if (error instanceof PaymentOperationError) return { ok: false, error: error.message };
      throw error;
    }
  } else {
    const to = attendeeEmail(rsvp);
    const eventTitle = ctx.event?.title ?? ctx.instance!.series.title;
    const result = await confirmRsvpWithinCapacity({
      rsvpId: rsvp.id,
      ...(ctx.event ? { eventId: ctx.event.id } : { eventInstanceId: ctx.instance!.id }),
      expectedStatuses: [RsvpStatus.REJECTED],
      requireOpen: true,
      whenFull: "waitlist",
      ...(to ? { notification: { to, eventTitle, checkInToken: rsvp.checkInToken } } : {}),
    });
    if (result === "closed") return { ok: false, error: ctx.event ? "This event is no longer open for approvals." : "This occurrence is no longer open for approvals." };
    if (result !== "confirmed" && result !== "waitlisted") return { ok: false, error: "This RSVP was changed by another organiser." };
    status = result === "confirmed" ? "CONFIRMED" : "WAITLISTED";
  }

  await recordAuditEvent({ action: "RSVP_REACCEPTED", actorUserId: userId, organisationId: org.id, targetType: "RSVP", targetId: rsvp.id, metadata: { status } });
  revalidateRsvpPaths(paths);
  return { ok: true, data: { status } };
}
