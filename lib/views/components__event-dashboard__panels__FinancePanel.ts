import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
import { prisma } from "@/lib/db";
import { CATEGORY_LABELS, financeCurrency } from "@/lib/claims/shared";
import { loadEventFinance } from "@/lib/finance";
import { eligibilityChanges } from "@/lib/claims/policies/claims";
import { listPolicies, policyAdminRows, policyStageOptions } from "@/lib/claims/policies/view";
import { safeTimeZone } from "@/lib/timeZone";
import { formatMoney } from "@/lib/payments/money";
import { listFailedRefunds } from "@/lib/payments/operations/retryRefund";
import { listRefundableOrders } from "@/lib/payments/operations/cancelledRefund";

/**
 * The Finance tab (docs/FINANCE.md). Owners and admins see the event's money,
 * every claim, payouts, refund requests and failed refunds; everyone else on the dashboard
 * files and follows their own claims.
 */
export async function loadFinancePanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  const scope = { organisationSlug: ctx.organisation.slug, eventId: ctx.event.id };
  const categories = Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }));
  const currency = await financeCurrency(prisma, ctx.event);
  if (ctx.permissions.isAdmin) {
    const finance = await loadEventFinance(ctx.event.id, ctx.organisation.id);
    if (!finance) return null;
    const [policies, stageOptions, changed, failedRefunds, refundableOrders] = await Promise.all([
      listPolicies(prisma, ctx.event.id),
      policyStageOptions(prisma, ctx.event.id),
      // Waiting policy claims whose person no longer qualifies, flagged for approvers.
      prisma.expenseClaim.findMany({ where: { id: { in: finance.claims.map((claim) => claim.id) }, status: "SUBMITTED", policyId: { not: null } }, select: { id: true, status: true, eventId: true, rsvpId: true, policyId: true, eligibilitySnapshot: true } }).then((rows) => eligibilityChanges(prisma, rows)),
      // Refunds the provider refused, by order (docs/PAYMENTS.md).
      listFailedRefunds({ eventId: ctx.event.id }, ctx.organisation.id),
      // Money left on cancelled or expired orders, refunded by order.
      listRefundableOrders({ eventId: ctx.event.id }, ctx.organisation.id),
    ]);
    const claims = finance.claims.map((claim) => ({ ...claim, eligibilityChanged: changed.get(claim.id) ?? null }));
    return {
      admin: true as const, scope, categories, currency, finance: { ...finance, claims }, failedRefunds, refundableOrders, userId: ctx.userId, exportHref: `/api/exports/events/${ctx.event.id}/finance`,
      policies: policyAdminRows(policies, currency, safeTimeZone(ctx.event.timezone)),
      policyOptions: { ...stageOptions, categories },
    };
  }
  const mine = await prisma.expenseClaim.findMany({
    where: { eventId: ctx.event.id, submittedByUserId: ctx.userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    select: { id: true, status: true, category: true, description: true, amountMinor: true, approvedMinor: true, currency: true, decisionNote: true, createdAt: true, receipts: { select: { id: true } } },
  });
  return {
    admin: false as const,
    scope,
    categories,
    currency,
    claims: mine.map((claim) => ({
      id: claim.id,
      status: claim.status,
      category: CATEGORY_LABELS[claim.category],
      description: claim.description,
      amount: formatMoney(claim.amountMinor, claim.currency),
      approved: claim.approvedMinor != null ? formatMoney(claim.approvedMinor, claim.currency) : null,
      note: claim.decisionNote,
      createdAt: claim.createdAt.toISOString(),
      receiptIds: claim.receipts.map((receipt) => receipt.id),
    })),
  };
}

export type FinancePanelData = NonNullable<Awaited<ReturnType<typeof loadFinancePanel>>>;
