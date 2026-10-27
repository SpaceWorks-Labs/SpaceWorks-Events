import "server-only";

import { TeamTicketMode, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { COLLECTED } from "@/lib/payments/operations/shared";
import { buyerCancellation } from "@/lib/payments/operations/refund";
import type { AttendanceReleaseKind } from "@/lib/attendanceCheck";

/*
 * What a "No" does to a registration when "Free the place when a guest says
 * No" is on (docs/ATTENDANCE.md, docs/PAYMENTS.md). Money is never moved
 * outside the paths a buyer or organiser already has:
 *
 * - free (no order, or nothing collected on it): the guest's own
 *   cancellation (lib/rsvpCancel.ts), with capacity, waitlist and team rules;
 * - a paid order holding only this ticket, bought by the person replying,
 *   while the buyer refund policy allows it: the buyer's own cancellation
 *   (`cancelOrderAsBuyer`), refunding what the policy says;
 * - the same, once the policy no longer allows it: the place is kept and a
 *   refund request is opened for the organisers to decide;
 * - a paid order with several tickets (or a team ticket covering the whole
 *   team), or one somebody else bought: nothing is cancelled; the No is
 *   recorded and organisers are told.
 */
export type ReleasePlan =
  | { kind: "free"; }
  | { kind: "paid"; orderId: string; }
  | { kind: "refundRequest"; orderId: string; }
  | { kind: "hold"; outcome: "multiTicket" | "notBuyer"; orderId: string; }
  | { kind: "none"; reason: string; };

const CHECKED_IN = "You've already checked in, so your place is kept.";

type Client = Prisma.TransactionClient | typeof prisma;

export async function planRelease(client: Client, rsvpId: string, now: Date = new Date()): Promise<ReleasePlan> {
  const rsvp = await client.rSVP.findUnique({
    where: { id: rsvpId },
    select: {
      checkedInAt: true,
      userId: true,
      guestEmail: true,
      user: { select: { email: true } },
      event: { select: { teamTicketMode: true } },
      order: {
        select: {
          id: true, buyerUserId: true, buyerEmail: true, teamId: true, teamName: true,
          _count: { select: { rsvps: true } },
          payments: { where: { status: { in: COLLECTED } }, select: { id: true }, take: 1 },
        },
      },
    },
  });
  if (!rsvp) return { kind: "none", reason: "This registration no longer exists." };
  if (rsvp.checkedInAt) return { kind: "none", reason: CHECKED_IN };
  const order = rsvp.order;
  if (!order || order.payments.length === 0) return { kind: "free" };
  const teamTicket = order.teamId != null && order.teamName != null && rsvp.event?.teamTicketMode === TeamTicketMode.PER_TEAM;
  if (order._count.rsvps > 1 || teamTicket) return { kind: "hold", outcome: "multiTicket", orderId: order.id };
  const ownEmail = (rsvp.user?.email ?? rsvp.guestEmail ?? "").trim().toLowerCase();
  const isBuyer = (rsvp.userId != null && order.buyerUserId === rsvp.userId) || (ownEmail !== "" && ownEmail === order.buyerEmail.trim().toLowerCase());
  if (!isBuyer) return { kind: "hold", outcome: "notBuyer", orderId: order.id };
  return (await buyerCancellation(order.id, now)) ? { kind: "paid", orderId: order.id } : { kind: "refundRequest", orderId: order.id };
}

/** What a "No" would release right now (null: the place is kept), for the email and the form. */
export async function releaseKindFor(rsvpId: string, releaseOnDecline: boolean, now: Date = new Date()): Promise<AttendanceReleaseKind | null> {
  if (!releaseOnDecline) return null;
  const plan = await planRelease(prisma, rsvpId, now);
  return plan.kind === "free" || plan.kind === "paid" ? plan.kind : null;
}
