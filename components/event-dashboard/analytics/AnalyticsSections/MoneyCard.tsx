import { formatMoney } from "@/lib/payments/money";
import type { RevenueSummary } from "@/lib/payments/revenueMetrics";
import { Bar, card, ColumnChart, Stats } from "./primitives";
import { cachedNumberFormat } from "@/lib/format/intlCache";

/* ---------- Money ---------- */

/** Short amounts for chart labels: ₹1.2k, ₹45. */
function compactMoney(minor: number, currency: string) {
  const major = minor / 100;
  try {
    return cachedNumberFormat("en-IN", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(major);
  } catch {
    return String(Math.round(major));
  }
}

/**
 * What the event took: collected, refunded and net; what's still owed or
 * being paid for; where it came from (ticket types, extras, fees) and how
 * (provider or in person); discounts and complimentary places given; any
 * chargebacks; and money in by day.
 */
/** `exportHref` links the orders CSV, for whoever may see the money. */
export function MoneyCard({ revenue, title = "Money", exportHref }: { revenue: RevenueSummary; title?: string; exportHref?: string }) {
  const money = (minor: number) => formatMoney(minor, revenue.currency);
  const refunds = revenue.refundedMinor + revenue.refundPendingMinor;
  const topTicket = Math.max(1, ...revenue.byTicket.map((row) => row.revenueMinor));
  const topMethod = Math.max(1, ...revenue.byMethod.map((row) => row.amountMinor));
  return (
    <section aria-labelledby="analytics-money-title" className={card}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="analytics-money-title" className="text-h4 text-ink">{title}{revenue.testOnly ? " (test payments)" : ""}</h2>
          <p className="text-caption text-ink-muted">
            {revenue.testOnly ? "Every payment so far was a test, so no real money moved." : "Money taken for tickets, after refunds."}
          </p>
        </div>
        {exportHref ? <a href={exportHref} className="text-body-ui font-semibold text-accent-text hover:underline">Download orders (CSV)</a> : null}
      </div>
      <Stats items={[
        { label: "Collected", value: money(revenue.collectedMinor) },
        { label: refunds > 0 && revenue.refundPendingMinor > 0 ? "Refunded (some on the way)" : "Refunded", value: money(refunds) },
        { label: "Net", value: money(revenue.netMinor) },
        { label: "Paid orders", value: String(revenue.orders.paid) },
        revenue.owedAtDeskMinor > 0 ? { label: `Owed at the desk (${revenue.orders.atDesk})`, value: money(revenue.owedAtDeskMinor) } : null,
        revenue.heldMinor > 0 ? { label: `Being paid now (${revenue.orders.awaiting})`, value: money(revenue.heldMinor) } : null,
        revenue.discountMinor > 0 ? { label: "Promo discounts", value: money(revenue.discountMinor) } : null,
        revenue.feesMinor > 0 ? { label: "Booking fees", value: money(revenue.feesMinor) } : null,
        revenue.addOnsMinor > 0 ? { label: "Extras", value: money(revenue.addOnsMinor) } : null,
        revenue.orders.complimentary > 0 ? { label: `Complimentary (${revenue.orders.complimentary})`, value: money(revenue.complimentaryValueMinor) } : null,
        revenue.orders.requested > 0 ? { label: "Requests waiting", value: String(revenue.orders.requested) } : null,
        revenue.automaticRefundMinor > 0 ? { label: "Late or duplicate, refunded", value: money(revenue.automaticRefundMinor) } : null,
      ]} />
      {revenue.disputes.open > 0 || revenue.disputes.lost > 0 ? (
        <p className="rounded-lg bg-danger-bg px-3 py-2 text-body-ui text-danger-fg">
          {revenue.disputes.open > 0 ? `${revenue.disputes.open} open ${revenue.disputes.open === 1 ? "chargeback" : "chargebacks"} (${money(revenue.disputes.openMinor)}): answer them in the payment provider's dashboard.` : ""}
          {revenue.disputes.lost > 0 ? ` ${revenue.disputes.lost} lost (${money(revenue.disputes.lostMinor)}).` : ""}
        </p>
      ) : null}
      {revenue.byTicket.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-label text-ink">By ticket</h3>
          <ul className="flex flex-col gap-2.5">
            {revenue.byTicket.map((row) => (
              <li key={row.name} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3">
                <span className="truncate text-sm text-ink-secondary">{row.name}</span>
                <Bar share={row.revenueMinor / topTicket} tone="bg-accent-text" />
                <span className="text-right text-sm tabular-nums text-ink">{money(row.revenueMinor)}<span className="block text-caption text-ink-muted">{row.tickets} sold</span></span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {revenue.byMethod.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-label text-ink">How people paid</h3>
          <ul className="flex flex-col gap-2.5">
            {revenue.byMethod.map((row) => (
              <li key={row.label} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3">
                <span className="truncate text-sm text-ink-secondary">{row.label}</span>
                <Bar share={row.amountMinor / topMethod} tone="bg-info-solid" />
                <span className="text-right text-sm tabular-nums text-ink">{money(row.amountMinor)}<span className="block text-caption text-ink-muted">{row.payments} {row.payments === 1 ? "payment" : "payments"}</span></span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {revenue.daily.largest > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-label text-ink">Money in, last {revenue.daily.columns.length} days</h3>
          <ColumnChart columns={revenue.daily.columns} largest={revenue.daily.largest} caption="Money collected per day" unit={revenue.currency} tone="bg-success-solid" format={(value) => compactMoney(value, revenue.currency)} />
        </div>
      ) : null}
    </section>
  );
}
