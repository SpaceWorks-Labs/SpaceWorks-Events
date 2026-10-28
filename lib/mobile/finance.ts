import "server-only";

import { prisma } from "@/lib/db";
import { CATEGORY_LABELS } from "@/lib/claims/shared";
import { formatMoney } from "@/lib/payments/money";
import { adminClaimsDtoSchema, checkInListsDtoSchema } from "@/lib/mobile/schemas";

/*
 * Organiser reads for event finance and check-in lists in the mobile apps.
 * The finance routes decide nothing themselves: filing, withdrawing and
 * deciding run the Finance tab's own actions (app/actions/finance.ts).
 * Payout records (references, notes) stay on the website.
 */

const CLAIMS_LIMIT = 200;

/** Every claim and refund request on this event, for its owners and admins. */
export async function loadEventClaims(eventId: string) {
  const [event, claims, requests] = await Promise.all([
    prisma.event.findUniqueOrThrow({ where: { id: eventId }, select: { currency: true } }),
    prisma.expenseClaim.findMany({
      where: { eventId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: CLAIMS_LIMIT,
      select: {
        id: true, kind: true, status: true, category: true, description: true, amountMinor: true, approvedMinor: true, currency: true,
        decisionNote: true, createdAt: true, payeeName: true, receipts: { select: { id: true } },
      },
    }),
    prisma.refundRequest.findMany({
      where: { order: { eventId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: CLAIMS_LIMIT,
      select: { id: true, status: true, reason: true, createdAt: true, order: { select: { id: true, reference: true, buyerName: true } } },
    }),
  ]);
  return adminClaimsDtoSchema.parse({
    currency: event.currency ?? claims[0]?.currency ?? "INR",
    claims: claims.map((claim) => ({
      id: claim.id,
      kind: claim.kind,
      claimant: claim.payeeName,
      status: claim.status,
      category: CATEGORY_LABELS[claim.category],
      amount: formatMoney(claim.amountMinor, claim.currency),
      approved: claim.approvedMinor != null ? formatMoney(claim.approvedMinor, claim.currency) : null,
      note: claim.decisionNote || null,
      description: claim.description,
      createdAt: claim.createdAt.toISOString(),
      receiptIds: claim.receipts.map((receipt) => receipt.id),
    })),
    refundRequests: requests.map((request) => ({
      id: request.id,
      orderId: request.order.id,
      reference: request.order.reference,
      buyerName: request.order.buyerName,
      reason: request.reason,
      status: request.status,
      createdAt: request.createdAt.toISOString(),
    })),
  });
}

/** The event's open custom check-in lists, in desk order, with how many are checked in to each. */
export async function loadCheckInLists(eventId: string) {
  const lists = await prisma.checkInList.findMany({
    where: { eventId, archived: false },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, requiresEntryCheckIn: true, _count: { select: { records: true } } },
  });
  return checkInListsDtoSchema.parse({
    lists: lists.map((list) => ({ id: list.id, name: list.name, requiresEntryCheckIn: list.requiresEntryCheckIn, checkedIn: list._count.records })),
  });
}
