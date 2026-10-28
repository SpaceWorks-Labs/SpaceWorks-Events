import "server-only";

import { OrderStatus, PaymentRefundStatus, PaymentStatus } from "@prisma/client";
import { decodeCursor, encodeCursor } from "@/lib/api/v1/pagination";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/payments/money";
import { ORDER_SUBJECT_SELECT, orderSubject } from "@/lib/payments/targets";
import { loadOrderView } from "@/lib/views/app__order__token__page";
import { orderDetailDtoSchema, orderListDtoSchema, organiserOrderDtoSchema, paymentInfoSchema } from "@/lib/mobile/schemas";
import { attendeeDisplayName } from "@/lib/mobile/dto";

/*
 * Orders for the mobile apps. A buyer reaches their own orders by id while
 * signed in (never by the order's access token, which is never sent); an
 * organiser reaches an order of the event in the path. Provider ids, links
 * and payment references are never returned.
 */

const COLLECTED: PaymentStatus[] = [PaymentStatus.PAID_ONLINE, PaymentStatus.PAID_OFFLINE];
const ORDERS_PAGE = 30;

const moneySelect = {
  totalMinor: true,
  currency: true,
  status: true,
  payments: {
    select: { status: true, amountMinor: true, provider: true, refunds: { where: { status: { not: PaymentRefundStatus.FAILED } }, select: { amountMinor: true } } },
  },
} as const;

type MoneyRow = { totalMinor: bigint; currency: string; status: OrderStatus; payments: Array<{ status: PaymentStatus; amountMinor: bigint; provider: string; refunds: Array<{ amountMinor: bigint; }>; }>; };

/** Paid, refunded and still owed on an order; `payAtDesk` when it was reserved to pay in person. */
export function orderMoney(order: MoneyRow) {
  const paid = order.payments.filter((payment) => COLLECTED.includes(payment.status)).reduce((sum, payment) => sum + payment.amountMinor, BigInt(0));
  const refunded = order.payments.flatMap((payment) => payment.refunds).reduce((sum, refund) => sum + refund.amountMinor, BigInt(0));
  const waived = order.payments.some((payment) => payment.status === PaymentStatus.WAIVED);
  const open = order.status === OrderStatus.CONFIRMED || order.status === OrderStatus.PENDING;
  const due = open && !waived && paid < order.totalMinor ? order.totalMinor - paid : BigInt(0);
  const payAtDesk = order.status === OrderStatus.CONFIRMED && order.payments.some((payment) => payment.status === PaymentStatus.PENDING && payment.provider === "OFFLINE");
  return { paid, refunded, due, payAtDesk };
}

/** What the check-in desk should collect for this guest's order, or null when the guest has no order. */
export async function paymentInfoForRsvp(eventId: string, rsvpId: string) {
  const rsvp = await prisma.rSVP.findFirst({ where: { id: rsvpId, eventId }, select: { order: { select: { id: true, ...moneySelect } } } });
  if (!rsvp?.order) return null;
  const money = orderMoney(rsvp.order);
  return paymentInfoSchema.parse({ due: money.due > BigInt(0) ? formatMoney(money.due, rsvp.order.currency) : null, orderId: rsvp.order.id, payAtDesk: money.payAtDesk });
}

/** The signed-in buyer's orders, newest first. */
export async function listMyOrders(userId: string, rawCursor?: string) {
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) return null;
  const rows = await prisma.order.findMany({
    where: {
      buyerUserId: userId,
      ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.timestamp) } }, { createdAt: new Date(cursor.timestamp), id: { lt: cursor.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ORDERS_PAGE + 1,
    select: { id: true, reference: true, status: true, totalMinor: true, currency: true, createdAt: true, holdExpiresAt: true, _count: { select: { rsvps: true } }, ...ORDER_SUBJECT_SELECT },
  });
  const page = rows.slice(0, ORDERS_PAGE);
  const last = page.at(-1);
  return orderListDtoSchema.parse({
    orders: page.map((order) => {
      const subject = orderSubject(order);
      return {
        id: order.id,
        reference: order.reference,
        status: order.status,
        total: formatMoney(order.totalMinor, order.currency),
        totalMinor: order.totalMinor.toString(),
        currency: order.currency,
        createdAt: order.createdAt.toISOString(),
        holdExpiresAt: order.holdExpiresAt?.toISOString() ?? null,
        ticketCount: order._count.rsvps,
        event: subject ? { title: subject.title, organisation: subject.organisation.name, startDateTime: subject.start?.toISOString() ?? null } : null,
      };
    }),
    nextCursor: rows.length > ORDERS_PAGE && last ? encodeCursor(last.createdAt, last.id) : null,
  });
}

/** One of the buyer's orders, as the order page shows it; null when it isn't theirs. */
export async function loadMyOrder(userId: string, orderId: string) {
  if (!orderId || orderId.length > 64) return null;
  const owned = await prisma.order.findFirst({ where: { id: orderId, buyerUserId: userId }, select: { id: true, accessToken: true } });
  if (!owned) return null;
  const view = await loadOrderView({ params: Promise.resolve({ token: owned.accessToken }) });
  return orderDetailDtoSchema.parse({
    id: owned.id,
    reference: view.reference,
    status: view.status,
    testMode: view.testMode,
    holdActive: view.holdActive,
    holdExpiresAt: view.holdExpiresAt,
    canPay: view.canPay,
    receiptAvailable: view.receiptHref !== null,
    total: view.total,
    subtotal: view.subtotal,
    discount: view.discount,
    refunded: view.refunded,
    refundPolicy: view.refundPolicy,
    cancellation: view.cancellation,
    canRequestRefund: view.canRequestRefund,
    refundRequest: view.refundRequest,
    free: view.free,
    pass: view.pass,
    event: view.event ? { title: view.event.title, organisation: view.event.organisation, startDateTime: view.event.start, timezone: view.event.timeZone } : null,
    lines: view.lines,
    tickets: view.tickets.map((ticket) => ({
      rsvpId: ticket.id,
      label: ticket.label,
      name: ticket.name,
      email: ticket.email,
      account: ticket.account,
      needsDetails: ticket.needsDetails,
      status: ticket.status,
      checkedIn: ticket.checkedIn,
      // The view links a confirmed ticket only; the token is the last path segment.
      ticketToken: ticket.ticketHref ? ticket.ticketHref.slice("/ticket/".length) : null,
      transferUntil: ticket.transferUntil,
    })),
  });
}

/** An order of this event for the organiser: buyer, money and tickets (no provider ids or references). */
export async function loadOrganiserOrder(eventId: string, orderId: string) {
  if (!orderId || orderId.length > 64) return null;
  const order = await prisma.order.findFirst({
    where: { id: orderId, eventId },
    select: {
      id: true, reference: true, buyerName: true, buyerEmail: true, createdAt: true, holdExpiresAt: true, ...moneySelect,
      rsvps: { orderBy: { createdAt: "asc" }, select: { id: true, status: true, checkedInAt: true, guestName: true, guestEmail: true, user: { select: { name: true, email: true } } } },
    },
  });
  if (!order) return null;
  const money = orderMoney(order);
  return organiserOrderDtoSchema.parse({
    id: order.id,
    reference: order.reference,
    status: order.status,
    buyerName: order.buyerName,
    buyerEmail: order.buyerEmail,
    total: formatMoney(order.totalMinor, order.currency),
    paid: formatMoney(money.paid, order.currency),
    refunded: formatMoney(money.refunded, order.currency),
    due: formatMoney(money.due, order.currency),
    currency: order.currency,
    createdAt: order.createdAt.toISOString(),
    holdExpiresAt: order.holdExpiresAt?.toISOString() ?? null,
    payAtDesk: money.payAtDesk,
    tickets: order.rsvps.map((rsvp) => ({ rsvpId: rsvp.id, name: attendeeDisplayName(rsvp), status: rsvp.status, checkedIn: rsvp.checkedInAt !== null })),
  });
}
