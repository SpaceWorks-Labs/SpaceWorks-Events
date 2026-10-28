import "server-only";

import { ExpenseClaimStatus, OrderStatus, PaymentRefundStatus, PaymentStatus, RefundRequestStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { CATEGORY_LABELS, financeCurrency } from "@/lib/claims/shared";
import { formatMoney, minorToDecimalString } from "@/lib/payments/money";
import { offlineMethodLabel } from "@/lib/payments/paymentMethod";

/**
 * An event's money in one place (docs/FINANCE.md): what came in (tickets and
 * entry fees, less refunds), what went out (paid expense claims and prize
 * money), the net, and the budget. Every figure is in the event's currency.
 */

const ZERO = BigInt(0);
const COLLECTED = [PaymentStatus.PAID_ONLINE, PaymentStatus.PAID_OFFLINE];
const LIST_LIMIT = 200;

function net(rows: Array<{ amountMinor: bigint; reversesId: string | null; }>) {
  return rows.reduce((sum, row) => (row.reversesId ? sum - row.amountMinor : sum + row.amountMinor), ZERO);
}

/** Collected money and committed refunds on the event's orders, split into tickets and entry fees. */
async function income(eventId: string) {
  const payments = await prisma.payment.findMany({
    where: { status: { in: COLLECTED }, order: { eventId } },
    select: { amountMinor: true, order: { select: { submissionId: true } }, refunds: { where: { status: { in: [PaymentRefundStatus.PENDING, PaymentRefundStatus.SUCCEEDED] } }, select: { amountMinor: true } } },
  });
  let tickets = ZERO;
  let entryFees = ZERO;
  let refunds = ZERO;
  for (const payment of payments) {
    if (payment.order.submissionId) entryFees += payment.amountMinor;
    else tickets += payment.amountMinor;
    refunds += payment.refunds.reduce((sum, refund) => sum + refund.amountMinor, ZERO);
  }
  return { tickets, entryFees, refunds };
}

export async function loadEventFinance(eventId: string, organisationId: string) {
  const event = await prisma.event.findFirst({ where: { id: eventId, organisationId }, select: { id: true, currency: true, organisationId: true, budgetMinor: true, participantClaimsEnabled: true, participantClaimCapMinor: true, crewClaimsEnabled: true } });
  if (!event) return null;
  const currency = await financeCurrency(prisma, event);
  const [money, claimPayouts, prizePayouts, claims, requests] = await Promise.all([
    income(eventId),
    prisma.claimPayout.findMany({ where: { eventId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: LIST_LIMIT }),
    prisma.prizePayout.findMany({ where: { eventId }, select: { amountMinor: true, reversesId: true } }),
    prisma.expenseClaim.findMany({
      where: { eventId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: LIST_LIMIT,
      select: { id: true, kind: true, status: true, payeeName: true, payeeEmail: true, category: true, description: true, amountMinor: true, approvedMinor: true, currency: true, decisionNote: true, createdAt: true, submittedByUserId: true, receipts: { select: { id: true } } },
    }),
    prisma.refundRequest.findMany({
      where: { order: { eventId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: LIST_LIMIT,
      select: { id: true, status: true, reason: true, approvedMinor: true, cancelTickets: true, decisionNote: true, createdAt: true, attendanceChecks: { select: { response: true }, take: 1 }, order: { select: { reference: true, buyerName: true, buyerEmail: true, totalMinor: true, currency: true, status: true } } },
    }),
  ]);
  // Totals come from every claim, not just the listed page.
  const claimTotals = await prisma.expenseClaim.groupBy({ by: ["status"], where: { eventId }, _sum: { amountMinor: true, approvedMinor: true } });
  const sumOf = (status: ExpenseClaimStatus, field: "amountMinor" | "approvedMinor") => claimTotals.find((row) => row.status === status)?._sum[field] ?? ZERO;
  const allClaimPayouts = await prisma.claimPayout.findMany({ where: { eventId }, select: { amountMinor: true, reversesId: true } });
  const expensesPaid = net(allClaimPayouts);
  const prizesPaid = net(prizePayouts);
  const netIncome = money.tickets + money.entryFees - money.refunds;
  const approvedUnpaid = sumOf(ExpenseClaimStatus.APPROVED, "approvedMinor");
  const committed = expensesPaid + prizesPaid + approvedUnpaid;
  const label = (value: bigint) => formatMoney(value, currency);
  const reversed = new Set(claimPayouts.flatMap((payout) => (payout.reversesId ? [payout.reversesId] : [])));
  return {
    currency,
    settings: {
      budget: event.budgetMinor ? minorToDecimalString(event.budgetMinor, currency) : "",
      participantClaimsEnabled: event.participantClaimsEnabled,
      participantCap: event.participantClaimCapMinor ? minorToDecimalString(event.participantClaimCapMinor, currency) : "",
      crewClaimsEnabled: event.crewClaimsEnabled,
    },
    summary: {
      tickets: label(money.tickets),
      entryFees: money.entryFees > ZERO ? label(money.entryFees) : null,
      refunds: label(money.refunds),
      netIncome: label(netIncome),
      expensesPaid: label(expensesPaid),
      prizesPaid: label(prizesPaid),
      approvedUnpaid: label(approvedUnpaid),
      waiting: label(sumOf(ExpenseClaimStatus.SUBMITTED, "amountMinor")),
      net: label(netIncome - expensesPaid - prizesPaid),
      negative: netIncome - expensesPaid - prizesPaid < ZERO,
      // `left` is how far under (or, when `over`, over) the budget the event is.
      budget: event.budgetMinor ? { total: label(event.budgetMinor), committed: label(committed), left: label(committed > event.budgetMinor ? committed - event.budgetMinor : event.budgetMinor - committed), over: committed > event.budgetMinor } : null,
    },
    claims: claims.map((claim) => ({
      id: claim.id,
      kind: claim.kind,
      status: claim.status,
      payeeName: claim.payeeName,
      payeeEmail: claim.payeeEmail,
      category: CATEGORY_LABELS[claim.category],
      description: claim.description,
      amount: formatMoney(claim.amountMinor, claim.currency),
      approved: claim.approvedMinor != null ? formatMoney(claim.approvedMinor, claim.currency) : null,
      approvedInput: minorToDecimalString(claim.approvedMinor ?? claim.amountMinor, claim.currency),
      note: claim.decisionNote,
      createdAt: claim.createdAt.toISOString(),
      submittedByUserId: claim.submittedByUserId,
      receiptIds: claim.receipts.map((receipt) => receipt.id),
    })),
    payouts: claimPayouts.map((payout) => ({
      id: payout.id,
      payeeName: payout.payeeName,
      amount: `${payout.reversesId ? "−" : ""}${formatMoney(payout.amountMinor, payout.currency)}`,
      method: offlineMethodLabel(payout.method),
      reference: payout.reference,
      note: payout.note,
      paidAt: payout.paidAt.toISOString(),
      isReversal: payout.reversesId != null,
      reversed: reversed.has(payout.id),
    })),
    refundRequests: requests.map((request) => ({
      id: request.id,
      status: request.status,
      open: request.status === RefundRequestStatus.OPEN && request.order.status === OrderStatus.CONFIRMED,
      reason: request.reason,
      reference: request.order.reference,
      buyer: request.order.buyerName || request.order.buyerEmail,
      orderTotal: formatMoney(request.order.totalMinor, request.order.currency),
      approved: request.approvedMinor != null ? formatMoney(request.approvedMinor, request.order.currency) : null,
      cancelTickets: request.cancelTickets,
      note: request.decisionNote,
      // Opened by a guest's "No" to attendance confirmation: their answer now (docs/ATTENDANCE.md).
      attendanceAnswer: request.attendanceChecks[0]?.response ?? null,
      createdAt: request.createdAt.toISOString(),
    })),
    capped: claims.length === LIST_LIMIT,
  };
}

export type EventFinanceView = NonNullable<Awaited<ReturnType<typeof loadEventFinance>>>;

/** What an event spent, for the PDF report: paid claims and prizes (net of reversals), approved claims not yet paid, and the budget. Null when there is nothing to show. */
export async function loadSpendingTotals(eventId: string) {
  const [event, claimPayouts, prizePayouts, approved] = await Promise.all([
    prisma.event.findUnique({ where: { id: eventId }, select: { currency: true, organisationId: true, budgetMinor: true } }),
    prisma.claimPayout.findMany({ where: { eventId }, select: { amountMinor: true, reversesId: true } }),
    prisma.prizePayout.findMany({ where: { eventId }, select: { amountMinor: true, reversesId: true } }),
    prisma.expenseClaim.aggregate({ where: { eventId, status: ExpenseClaimStatus.APPROVED }, _sum: { approvedMinor: true } }),
  ]);
  if (!event) return null;
  const expensesPaid = net(claimPayouts);
  const prizesPaid = net(prizePayouts);
  const approvedUnpaid = approved._sum.approvedMinor ?? ZERO;
  if (expensesPaid === ZERO && prizesPaid === ZERO && approvedUnpaid === ZERO && !event.budgetMinor) return null;
  return {
    currency: await financeCurrency(prisma, event),
    expensesPaidMinor: Number(expensesPaid),
    prizesPaidMinor: Number(prizesPaid),
    approvedUnpaidMinor: Number(approvedUnpaid),
    budgetMinor: event.budgetMinor == null ? null : Number(event.budgetMinor),
  };
}
