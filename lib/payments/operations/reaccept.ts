import "server-only";

import { OrderStatus, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { enqueueRsvpConfirmation } from "@/lib/outbox";
import { hasFreeSeats, ORDER_SUBJECT_SELECT, orderSubject } from "../targets";
import { promoStillFits } from "../promo";
import { COLLECTED, lockOrder, onlineAccount, PaymentOperationError } from "./shared";
import { offerInTransaction } from "./waitlist";

/**
 * Re-accept a declined paid request. It goes back through the payment flow and
 * is never confirmed without payment: with room for the whole order it is
 * offered its seats (held, with a payment link emailed), otherwise it waits on
 * the waitlist as a request again, to be offered when places come free. The
 * order moves as a whole, as it did when it was declined.
 */
export async function reacceptDeclinedOrder(params: { orderId: string; organisationId: string; actorUserId: string; now?: Date; }): Promise<"offered" | "waitlisted"> {
  const account = await onlineAccount(params.organisationId);
  const now = params.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await lockOrder(tx, params.orderId);
    const order = await tx.order.findFirst({
      where: { id: params.orderId, organisationId: params.organisationId },
      select: {
        id: true, status: true, buyerEmail: true, promoCodeId: true, ...ORDER_SUBJECT_SELECT,
        rsvps: { select: { id: true, orderId: true, eventId: true, eventInstanceId: true, ticketTypeId: true, status: true, checkInToken: true } },
        payments: { where: { status: { in: COLLECTED } }, select: { id: true } },
      },
    });
    // Declining cancels the order and rejects every registration on it, with nothing collected.
    const declined = order && order.status === OrderStatus.CANCELLED && order.rsvps.length > 0
      && order.rsvps.every((rsvp) => rsvp.status === RsvpStatus.REJECTED) && order.payments.length === 0;
    if (!order || !declined) throw new PaymentOperationError("Only a declined request can be re-accepted.");
    const subject = orderSubject(order);
    if (!subject || !subject.open(now)) throw new PaymentOperationError("This event is no longer open for registration.");
    // Declining released its promo code's use: it comes back only if the code still has one.
    if (!(await promoStillFits(tx, order, now))) throw new PaymentOperationError("The promo code on this order has been used up since it was declined, so it can't be re-accepted.");

    await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.REQUESTED } });
    if (await hasFreeSeats(tx, order.rsvps, now)) {
      await offerInTransaction(tx, { orderId: order.id, organisationId: params.organisationId, provider: account.provider, testMode: account.testMode, actorUserId: params.actorUserId, now });
      await recordAuditEvent({ action: "ORDER_REACCEPTED", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Order", targetId: order.id, metadata: { result: "offered" }, client: tx });
      return "offered";
    }
    await tx.rSVP.updateMany({ where: { orderId: order.id }, data: { status: RsvpStatus.WAITLISTED } });
    await enqueueRsvpConfirmation(tx, { to: order.buyerEmail, eventTitle: subject.title, status: RsvpStatus.WAITLISTED, checkInToken: order.rsvps[0]!.checkInToken });
    await recordAuditEvent({ action: "ORDER_REACCEPTED", actorUserId: params.actorUserId, organisationId: params.organisationId, targetType: "Order", targetId: order.id, metadata: { result: "waitlisted" }, client: tx });
    return "waitlisted";
  });
}
