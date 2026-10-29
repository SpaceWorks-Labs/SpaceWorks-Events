import Link from "next/link";
import { Download } from "lucide-react";
import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadFinancePanel } from "@/lib/views/components__event-dashboard__panels__FinancePanel";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader, StatTile } from "@/components/ui/display";
import { ClaimForm } from "@/components/event-dashboard/finance/ClaimForm";
import { ClaimsList } from "@/components/event-dashboard/finance/ClaimsList";
import { ClaimPayoutsList, FinanceSettingsForm, RefundRequestsList } from "@/components/event-dashboard/finance/FinanceAdmin";
import { ReimbursementPolicies } from "@/components/event-dashboard/finance/ReimbursementPolicies";
import { NoPermission } from "./shared";
import { HelpLink } from "@/components/help/HelpLink";
import { FailedRefundsList } from "@/components/payments/FailedRefundsList";

/**
 * The event dashboard's Finance tab (docs/FINANCE.md): money in and out
 * against the budget, expense claims, payouts and refund requests for
 * owners and admins; filing and following your own claims for everyone else.
 */
export async function FinancePanel({ ctx }: { ctx: EventDashboardContext; }) {
  const data = await loadFinancePanel({ ctx });
  if (!data) return <NoPermission>You do not have access to this event&apos;s finances.</NoPermission>;
  const timezone = ctx.event.timezone;
  const claimCard = (
    <Card as="section" className="rounded-xl" aria-labelledby="claim-new-title">
      <CardHeader title={<span id="claim-new-title">Claim expenses</span>} description="Spent your own money on this event? Claim it back. Owners and admins approve and pay claims." />
      <ClaimForm kind="staff" hidden={data.scope} categories={data.categories} currency={data.currency} />
    </Card>
  );
  if (!data.admin) {
    return (
      <div className="flex flex-col gap-5">
        {claimCard}
        <Card as="section" className="rounded-xl" aria-labelledby="claim-mine-title">
          <CardHeader title={<span id="claim-mine-title">Your claims</span>} />
          <ClaimsList scope={data.scope} claims={data.claims} admin={false} timezone={timezone} currency={data.currency} />
        </Card>
      </div>
    );
  }
  const { finance } = data;
  const { summary } = finance;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <h2 className="text-h3 text-ink">Money in and out</h2>
          <HelpLink article="finance/overview-and-budget" />
        </div>
        <Button asChild variant="secondary"><Link href={data.exportHref} prefetch={false}><Download aria-hidden className="size-4" />Download CSV</Link></Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Income" value={summary.netIncome} hint={`Tickets ${summary.tickets}${summary.entryFees ? ` · entry fees ${summary.entryFees}` : ""} · refunds ${summary.refunds}`} />
        <StatTile label="Expenses paid" value={summary.expensesPaid} hint={`${summary.approvedUnpaid} approved, not paid · ${summary.waiting} waiting`} />
        <StatTile label="Prize money paid" value={summary.prizesPaid} />
        <StatTile label="Net" value={summary.net} tone={summary.negative ? "attention" : "default"} hint="Income less expenses and prizes paid" />
      </div>
      {summary.budget ? (
        <Callout tone={summary.budget.over ? "danger" : "info"} title={summary.budget.over ? "Over budget" : `Budget ${summary.budget.total}`}>
          {summary.budget.committed} spent or approved; {summary.budget.over ? `over by ${summary.budget.left}` : `${summary.budget.left} left`}.
        </Callout>
      ) : null}
      <Card as="section" className="rounded-xl" aria-labelledby="claims-title">
        <CardHeader title={<span id="claims-title">Expense claims</span>} description={finance.capped ? "Showing the latest 200 claims. The CSV has every payment." : undefined} />
        <ClaimsList scope={data.scope} claims={finance.claims} admin timezone={timezone} currency={data.currency} />
      </Card>
      <Card as="section" className="rounded-xl" aria-labelledby="reimbursement-policies-title">
        <CardHeader title={<span id="reimbursement-policies-title" className="inline-flex items-center gap-1">Reimbursement policies<HelpLink article="finance/reimbursement-policies" /></span>} description="Pay back travel and costs per stage: finalists of a judging round, teams mentored in a round, crew or everyone confirmed. Each has a cap per person and an optional budget." />
        <ReimbursementPolicies scope={data.scope} policies={data.policies} options={data.policyOptions} currency={data.currency} timezone={timezone} />
      </Card>
      <Card as="section" className="rounded-xl" aria-labelledby="refund-requests-title">
        <CardHeader title={<span id="refund-requests-title">Refund requests</span>} description="Buyers asking for money back outside your refund policy, from their order page." />
        <RefundRequestsList scope={data.scope} requests={finance.refundRequests} timezone={timezone} currency={data.currency} />
      </Card>
      {data.failedRefunds.length > 0 ? (
        <Card as="section" className="rounded-xl" aria-labelledby="failed-refunds-title">
          <CardHeader title={<span id="failed-refunds-title" className="inline-flex items-center gap-1">Failed refunds<HelpLink article="payments/refunds" section="retrying-a-failed-refund" /></span>} description="Refunds the payment provider refused. Check your balance with the provider, then retry." />
          <FailedRefundsList target={data.scope} refunds={data.failedRefunds} timezone={timezone} />
        </Card>
      ) : null}
      <Card as="section" className="rounded-xl" aria-labelledby="claim-payouts-title">
        <CardHeader title={<span id="claim-payouts-title">Claim payments</span>} description="Every payment stays on record. A mistake is reversed, never edited." />
        <ClaimPayoutsList scope={data.scope} payouts={finance.payouts} timezone={timezone} />
      </Card>
      {claimCard}
      <Card as="section" className="rounded-xl" aria-labelledby="finance-settings-title">
        <CardHeader title={<span id="finance-settings-title">Budget and participant claims</span>} />
        <FinanceSettingsForm scope={data.scope} settings={finance.settings} currency={data.currency} />
      </Card>
    </div>
  );
}
