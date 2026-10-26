import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
import { prisma } from "@/lib/db";
import { CATEGORY_LABELS, financeCurrency } from "@/lib/claims/shared";
import { loadEventFinance } from "@/lib/finance";
import { formatMoney } from "@/lib/payments/money";

/**
 * The Finance tab (docs/FINANCE.md). Owners and admins see the event's money,
 * every claim, payouts and refund requests; everyone else on the dashboard
 * files and follows their own claims.
 */
export async function loadFinancePanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  const scope = { organisationSlug: ctx.organisation.slug, eventId: ctx.event.id };
  const categories = Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }));
  const currency = await financeCurrency(prisma, ctx.event);
  if (ctx.permissions.isAdmin) {
    const finance = await loadEventFinance(ctx.event.id, ctx.organisation.id);
    return finance ? { admin: true as const, scope, categories, currency, finance, userId: ctx.userId, exportHref: `/api/exports/events/${ctx.event.id}/finance` } : null;
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
