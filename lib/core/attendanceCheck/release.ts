import "server-only";

import { TeamTicketMode, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { COLLECTED } from "@/lib/payments/operations/shared";
import { buyerCancellation } from "@/lib/payments/operations/refund";
import { formatMoney } from "@/lib/payments/money";
import type { AttendanceRelease } from "@/lib/attendanceCheck";

/*
 * What a "No" does to a registration when "Free the place when a guest says
 * No" is on (docs/ATTENDANCE.md, docs/PAYMENTS.md). Money is never moved
 * outside the paths a buyer or organiser already has:
 *
 * - free (no order, or an order that cost nothing): the guest's own
 *   cancellation (lib/rsvpCancel.ts), with capacity, waitlist and team rules;
 * - any order that cost money, paid or still owed (pay at the desk), holding
 *   only this ticket and bought by the person replying, while the buyer
 *   refund policy allows it: the buyer's own cancellation
 *   (`cancelOrderAsBuyer`), refunding what the policy says (nothing when
 *   nothing was collected; an owed desk payment is cancelled);
 * - the same with money collected, once the policy no longer allows it: the
 *   place is kept and a refund request is opened for the organisers;
 * - an order with several tickets (or a team ticket covering the whole team),
 *   or one somebody else bought: nothing is cancelled; the No is recorded and
 *   organisers are told.
 */
export type ReleasePlan =
  | { kind: "free"; }
  | { kind: "paid"; orderId: string; refundMinor: bigint; currency: string; }
  | { kind: "refundRequest"; orderId: string; }
  | { kind: "hold"; outcome: "multiTicket" | "notBuyer"; orderId: string; }
  | { kind: "none"; reason: string; };

const CHECKED_IN = "You've already checked in, so your place is kept.";
const ZERO = BigInt(0);

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
          id: true, buyerUserId: true, buyerEmail: true, teamId: true, teamName: true, totalMinor: true, currency: true,
          _count: { select: { rsvps: true } },
          payments: { where: { status: { in: COLLECTED } }, select: { id: true }, take: 1 },
        },
      },
    },
  });
  if (!rsvp) return { kind: "none", reason: "This registration no longer exists." };
  if (rsvp.checkedInAt) return { kind: "none", reason: CHECKED_IN };
  const order = rsvp.order;
  // Only an order that cost nothing is a free place; an owed one follows the paid rules.
  if (!order || order.totalMinor <= ZERO) return { kind: "free" };
  const teamTicket = order.teamId != null && order.teamName != null && rsvp.event?.teamTicketMode === TeamTicketMode.PER_TEAM;
  if (order._count.rsvps > 1 || teamTicket) return { kind: "hold", outcome: "multiTicket", orderId: order.id };
  const ownEmail = (rsvp.user?.email ?? rsvp.guestEmail ?? "").trim().toLowerCase();
  const isBuyer = (rsvp.userId != null && order.buyerUserId === rsvp.userId) || (ownEmail !== "" && ownEmail === order.buyerEmail.trim().toLowerCase());
  if (!isBuyer) return { kind: "hold", outcome: "notBuyer", orderId: order.id };
  const terms = await buyerCancellation(order.id, now);
  if (terms) return { kind: "paid", orderId: order.id, refundMinor: terms.refundMinor, currency: order.currency };
  if (order.payments.length > 0) return { kind: "refundRequest", orderId: order.id };
  return { kind: "none", reason: "Your order can't be cancelled online." };
}

/**
 * What a "No" would release right now (null: the place is kept), with the
 * refund the buyer policy would give, for the email (at delivery) and the
 * form (at render).
 */
export async function releaseFor(rsvpId: string, releaseOnDecline: boolean, now: Date = new Date()): Promise<AttendanceRelease | null> {
  if (!releaseOnDecline) return null;
  const plan = await planRelease(prisma, rsvpId, now);
  if (plan.kind === "free") return { kind: "free", refund: null };
  if (plan.kind === "paid") return { kind: "paid", refund: plan.refundMinor > ZERO ? formatMoney(plan.refundMinor, plan.currency) : null };
  return null;
}
