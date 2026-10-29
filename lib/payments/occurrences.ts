import "server-only";

import { OrderStatus, PaymentStatus, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { markOccurrenceCancelled } from "./occurrenceCancellation";
import { seatTakingWhere } from "./holds";
import { PaymentOperationError, refundOrder, submitRefunds } from "./operations";
import { ORDER_FOR_REFUND, recordRefundsTx } from "./operations/refund";
import { formatMoney } from "./money";
import { enqueuePaymentEmail } from "./email";
import { fenceOrganisation, lockOrderTargets, lockSeriesDates } from "./targets";
import { lockOrderRegistrations } from "./teamOrders";

const ZERO = BigInt(0);
const COLLECTED: PaymentStatus[] = [PaymentStatus.PAID_ONLINE, PaymentStatus.PAID_OFFLINE];

async function ownedDate(organisationId: string, seriesId: string, instanceId: string) {
  const date = await prisma.eventInstance.findFirst({
    where: { id: instanceId, eventSeriesId: seriesId, series: { organisationId } },
    select: { id: true, eventSeriesId: true, startDateTime: true, endDateTime: true, cancelledAt: true, series: { select: { title: true, timezone: true } } },
  });
  if (!date) throw new PaymentOperationError("Date not found.");
  return date;
}

/**
 * Give one date its own capacity, or clear it to use the series capacity.
 * Never below the seats already taken (confirmed, or held while paying),
 * counted under the series and date locks with the time read after them;
 * clearing checks the series capacity it would inherit, read in the same
 * transaction.
 */
export async function setOccurrenceCapacity(params: { organisationId: string; seriesId: string; instanceId: string; capacity: number | null; actorUserId: string; now?: Date; }) {
  const date = await ownedDate(params.organisationId, params.seriesId, params.instanceId);
  await prisma.$transaction(async (tx) => {
    await lockSeriesDates(tx, date.eventSeriesId, [date.id], params.now ?? new Date());
    const now = params.now ?? new Date();
    const effective = params.capacity ?? (await tx.eventSeries.findUniqueOrThrow({ where: { id: date.eventSeriesId }, select: { capacity: true } })).capacity;
    if (effective != null) {
      const taken = await tx.rSVP.count({ where: { eventInstanceId: date.id, ...seatTakingWhere(now) } });
      if (taken > effective) throw new PaymentOperationError(params.capacity != null ? `${taken} places are already taken on this date.` : `${taken} places are already taken on this date, more than the series capacity of ${effective}.`);
    }
    await tx.eventInstance.update({ where: { id: date.id }, data: { capacity: params.capacity } });
    await recordAuditEvent({ action: "EVENT_INSTANCE_CAPACITY_UPDATED", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "EventInstance", targetId: date.id, metadata: { capacity: params.capacity }, client: tx });
  });
}

/**
 * Cancel one date of a series. It stops taking registrations at once; then
 * every order with seats on it is settled:
 * - an order for this date alone is refunded in full and cancelled;
 * - a pass is refunded this date's share of what is left on it (what's left,
 *   times its seats on this date, over all its seats), and loses this date;
 * - an order still being paid for is released, and a request is declined.
 * Free registrations are removed. Everyone on the date is told by email.
 * Refunds are sent after the date is marked cancelled, so a retry never
 * refunds twice: each order is only handled while it still has seats here.
 */
export async function cancelOccurrence(params: { organisationId: string; seriesId: string; instanceId: string; actorUserId: string; reason: string; now?: Date; }) {
  const now = params.now ?? new Date();
  const date = await ownedDate(params.organisationId, params.seriesId, params.instanceId);
  if (date.endDateTime <= now) throw new PaymentOperationError("This date has already happened.");

  const notified = await prisma.$transaction(async (tx) => {
    await fenceOrganisation(tx, params.organisationId);
    await lockSeriesDates(tx, date.eventSeriesId, [date.id], now);
    return markOccurrenceCancelled(tx, { ...params, date, now });
  }, { timeout: 60_000 });

  const orders = await prisma.order.findMany({
    where: { rsvps: { some: { eventInstanceId: date.id } } },
    select: { id: true, status: true, eventInstanceId: true, payments: { where: { status: { in: COLLECTED } }, select: { id: true } } },
  });
  let refunded = 0;
  let failed = 0;
  for (const order of orders) {
    try {
      if (order.status === OrderStatus.CONFIRMED) {
        if (order.eventInstanceId === date.id) {
          await refundOrder({ orderId: order.id, organisationId: params.organisationId, actorUserId: params.actorUserId, amountMinor: null, reason: `Date cancelled: ${params.reason}`.slice(0, 500), cancelTickets: true, now });
        } else {
          await submitRefunds(await refundPassShare({ orderId: order.id, instanceId: date.id, actorUserId: params.actorUserId, reason: params.reason, now }));
        }
        refunded += 1;
      } else if (order.status === OrderStatus.PENDING) {
        // Ending the hold lets the scheduler close the payment page, then release the order.
        await prisma.$transaction([
          prisma.order.updateMany({ where: { id: order.id, status: OrderStatus.PENDING }, data: { holdExpiresAt: now } }),
          prisma.rSVP.updateMany({ where: { orderId: order.id, status: RsvpStatus.PENDING_PAYMENT }, data: { holdExpiresAt: now } }),
        ]);
      } else if (order.status === OrderStatus.REQUESTED) {
        await prisma.$transaction([
          prisma.order.updateMany({ where: { id: order.id, status: OrderStatus.REQUESTED }, data: { status: OrderStatus.CANCELLED } }),
          prisma.rSVP.deleteMany({ where: { orderId: order.id } }),
        ]);
      }
    } catch (error) {
      // For example a guest already checked in: the organiser settles that order by hand.
      if (!(error instanceof PaymentOperationError)) throw error;
      failed += 1;
    }
  }

  return { orders: orders.length, refunded, failed, notified };
}

/**
 * A pass loses one date, in one transaction: the series, the pass's dates by
 * id, the order, its payments and its registrations are locked (docs/PAYMENTS.md),
 * then the share is worked out, recorded and the date's places removed
 * together. A pass with nobody left on the date was handled already, so a
 * retry (or a second organiser) refunds nothing more; a date someone on the
 * pass already checked in to is refused, for the organiser to settle by hand.
 * Returns the online refunds to submit after commit.
 */
async function refundPassShare(params: { orderId: string; instanceId: string; actorUserId: string; reason: string; now: Date; }): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const head = await tx.order.findUnique({ where: { id: params.orderId }, select: { id: true, eventId: true, eventSeriesId: true, teamId: true, teamName: true } });
    if (!head) return [];
    await lockOrderTargets(tx, head, params.now);
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${head.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "orderId" = ${head.id} ORDER BY "id" FOR UPDATE`;
    await lockOrderRegistrations(tx, head);
    const order = await tx.order.findUniqueOrThrow({ where: { id: head.id }, select: { ...ORDER_FOR_REFUND, organisationId: true } });
    if (order.status !== OrderStatus.CONFIRMED) return [];
    const onDate = order.rsvps.filter((rsvp) => rsvp.eventInstanceId === params.instanceId);
    if (onDate.length === 0) return [];
    if (onDate.some((rsvp) => rsvp.checkedInAt)) throw new PaymentOperationError("Someone on this pass has already checked in to this date.");
    const reason = `Date cancelled: ${params.reason}`.slice(0, 500);
    const { wanted, onlineRefundIds, refundedPaymentId } = await recordRefundsTx(tx, order.payments, { wanted: null, share: { of: onDate.length, over: order.rsvps.length }, currency: order.currency, reason, actorUserId: params.actorUserId, now: params.now });
    const removed = await tx.rSVP.deleteMany({ where: { orderId: order.id, eventInstanceId: params.instanceId, checkedInAt: null } });
    if (removed.count !== onDate.length) throw new Error("The pass changed while its date was being cancelled.");
    if (wanted > ZERO && refundedPaymentId) {
      await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: refundedPaymentId, notice: "refunded" });
      await notifyChat(tx, order.organisationId, "refund", `Refund of ${formatMoney(wanted, order.currency)} for ${order.buyerEmail}. Reason: ${reason.slice(0, 200)}`);
    }
    await recordAuditEvent({ action: "PAYMENT_REFUNDED", actorUserId: params.actorUserId, organisationId: order.organisationId, targetType: "Order", targetId: order.id, metadata: { amountMinor: wanted.toString(), cancelled: false, instanceId: params.instanceId }, client: tx });
    return onlineRefundIds;
  });
}
