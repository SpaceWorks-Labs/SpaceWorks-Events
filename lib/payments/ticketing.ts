import "server-only";

import { TicketVisibility, type RefundPolicyKind } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { describeRefundPolicy } from "./refundPolicy";
import { DEFAULT_CURRENCY } from "./money";
import { canAcceptOnlinePayments } from "./settings";
import { listPublicAddOns, listPublicTicketTypes, type PublicTicketType } from "./tickets";

type Owner = { eventId: string; } | { eventSeriesId: string; };

/** Whether the signed-in viewer belongs to the organisation (members-only tickets). */
export async function viewerIsMember(organisationId: string) {
  const session = await auth();
  if (!session?.user?.id) return false;
  return Boolean(await prisma.membership.findFirst({ where: { userId: session.user.id, organisationId }, select: { id: true } }));
}

/**
 * What the registration form needs beyond the visible tickets: whether
 * promo and access codes exist, the add-ons, and the refund terms. Null when
 * nothing is sold. `sellsPaid` says whether a payment account may be needed.
 */
export async function ticketingInfo(owner: Owner, tickets: PublicTicketType[], currency: string, policy: { refundPolicyKind: RefundPolicyKind; refundPolicyHours: number | null; refundPolicyPercent: number | null; refundPolicyText: string; }) {
  const [addOns, hidden, promoCodes] = await Promise.all([
    listPublicAddOns(owner, currency),
    prisma.ticketType.count({ where: { ...owner, archivedAt: null, visibility: TicketVisibility.CODE } }),
    prisma.promoCode.count({ where: { ...owner, archivedAt: null } }),
  ]);
  if (tickets.length === 0 && hidden === 0) return null;
  const sellsPaid = hidden > 0 || addOns.some((addOn) => addOn.priceMinor > 0) || tickets.some((ticket) => ticket.priceMinor > 0 || ticket.flexible || ticket.feeMinor > 0);
  return {
    sellsPaid,
    promoCodes: promoCodes > 0,
    accessCodes: hidden > 0,
    addOns,
    refundPolicy: describeRefundPolicy({ kind: policy.refundPolicyKind, hours: policy.refundPolicyHours, percent: policy.refundPolicyPercent, text: policy.refundPolicyText }),
    refundPolicyText: policy.refundPolicyText,
  };
}

/** Everything a one-off event's public registration form needs to sell tickets (the event page, a team join link). */
export async function publicEventTicketing(organisationId: string, event: { id: string; currency: string | null; refundPolicyKind: RefundPolicyKind; refundPolicyHours: number | null; refundPolicyPercent: number | null; refundPolicyText: string; }) {
  const currency = event.currency ?? DEFAULT_CURRENCY;
  const tickets = await listPublicTicketTypes({ eventId: event.id }, currency, new Date(), { member: await viewerIsMember(organisationId) });
  const ticketing = await ticketingInfo({ eventId: event.id }, tickets, currency, event);
  const paidSalesOpen = ticketing?.sellsPaid ? await canAcceptOnlinePayments(organisationId) : false;
  return { tickets, ticketing, paidSalesOpen };
}
