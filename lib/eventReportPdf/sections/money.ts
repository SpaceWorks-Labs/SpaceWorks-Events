import "server-only";

import type { EventReportMetrics } from "@/lib/eventReport";
import { hasRevenue } from "@/lib/payments/revenueMetrics";
import type { ReportLayout } from "../layout";
import { plural } from "../style";
import { cachedNumberFormat } from "@/lib/format/intlCache";

/** What tickets brought in, when the event took any money. */
export function drawMoney(L: ReportLayout, metrics: EventReportMetrics) {
  const { section, subheading, facts } = L;
  // ---------- Money ----------

  const money = metrics.money;
  if (money && hasRevenue(money)) {
    // Currency codes rather than symbols: the report's fonts may not carry every sign.
    const amount = (minor: number) => `${money.currency} ${cachedNumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100)}`;
    section("Money", "Money", money.testOnly
      ? "Every payment was a test, so no real money moved."
      : metrics.targetType === "occurrence" ? "Tickets bought for this date. Passes cover several dates and are in the series' own figures." : "What tickets brought in, after refunds.");
    const refunds = money.refundedMinor + money.refundPendingMinor;
    const rows: Array<[string, string]> = [
      ["Collected", `${amount(money.collectedMinor)} from ${plural(money.orders.paid, "paid order")}`],
      ["Refunded", `${amount(refunds)}${money.refundPendingMinor > 0 ? `, ${amount(money.refundPendingMinor)} still on its way` : ""}`],
      ["Net", amount(money.netMinor)],
    ];
    if (money.discountMinor > 0) rows.push(["Promo discounts", amount(money.discountMinor)]);
    if (money.feesMinor > 0) rows.push(["Booking fees", amount(money.feesMinor)]);
    if (money.addOnsMinor > 0) rows.push(["Extras", amount(money.addOnsMinor)]);
    if (money.orders.complimentary > 0) rows.push(["Complimentary", `${plural(money.orders.complimentary, "order")}, worth ${amount(money.complimentaryValueMinor)}`]);
    if (money.owedAtDeskMinor > 0) rows.push(["Still owed at the desk", amount(money.owedAtDeskMinor)]);
    if (money.automaticRefundMinor > 0) rows.push(["Late or duplicate payments returned", amount(money.automaticRefundMinor)]);
    if (money.disputes.open > 0 || money.disputes.lost > 0) rows.push(["Chargebacks", `${money.disputes.open} open (${amount(money.disputes.openMinor)}), ${money.disputes.lost} lost (${amount(money.disputes.lostMinor)})`]);
    facts(rows);
    if (money.byTicket.length) {
      subheading("By ticket", "Takings for each ticket, before refunds.");
      facts(money.byTicket.map((row) => [row.name, `${amount(row.revenueMinor)} · ${plural(row.tickets, "ticket")}`]));
    }
    if (money.byMethod.length) {
      subheading("How people paid");
      facts(money.byMethod.map((row) => [row.label, `${amount(row.amountMinor)} · ${plural(row.payments, "payment")}`]));
    }
  }
  drawSpending(L, metrics);
}

/** Expense claims and prize money paid out, against the budget (docs/FINANCE.md). */
function drawSpending(L: ReportLayout, metrics: EventReportMetrics) {
  const spending = metrics.spending;
  if (!spending) return;
  const amount = (minor: number) => `${spending.currency} ${cachedNumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100)}`;
  const spent = spending.expensesPaidMinor + spending.prizesPaidMinor;
  if (metrics.money && hasRevenue(metrics.money)) L.subheading("Spending", "Expense claims and prize money paid out by hand.");
  else L.section("Money", "Spending", "Expense claims and prize money paid out by hand.");
  const rows: Array<[string, string]> = [["Expense claims paid", amount(spending.expensesPaidMinor)], ["Prize money paid", amount(spending.prizesPaidMinor)]];
  if (spending.approvedUnpaidMinor > 0) rows.push(["Approved, not yet paid", amount(spending.approvedUnpaidMinor)]);
  if (spending.budgetMinor != null) rows.push(["Budget", `${amount(spending.budgetMinor)}, ${amount(Math.abs(spending.budgetMinor - spent - spending.approvedUnpaidMinor))} ${spending.budgetMinor >= spent + spending.approvedUnpaidMinor ? "left" : "over"}`]);
  if (metrics.money && hasRevenue(metrics.money) && metrics.money.currency === spending.currency) rows.push(["Net after spending", amount(metrics.money.netMinor - spent)]);
  L.facts(rows);
}
