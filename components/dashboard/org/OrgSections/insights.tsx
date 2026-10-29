import Link from "next/link";
import type { OrgDashboard } from "@/lib/orgDashboard";
import { formatMoney } from "@/lib/payments/money";

/* ---------- Insights ---------- */

/** Best-attended recent events and returning attendees, for organisers. Counts only. */
export function OrgInsightsPanel({ insights }: { insights: NonNullable<OrgDashboard["insights"]> }) {
  const largest = Math.max(1, ...insights.topEvents.map((event) => event.came));
  const months = Math.round(insights.windowDays / 30);
  return (
    <section aria-labelledby="org-insights-title" className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-5">
      <div>
        <h2 id="org-insights-title" className="text-h4 text-ink">Insights</h2>
        <p className="text-caption text-ink-muted">Events that finished in the last {months} months.</p>
      </div>
      {insights.returning ? (
        <div className="flex flex-col gap-0.5">
          <strong className="font-display text-2xl font-semibold text-ink">{insights.returning.percent}%</strong>
          <span className="text-caption text-ink-muted">
            came back for another event ({insights.returning.returning} of {insights.returning.people} people)
          </span>
        </div>
      ) : null}
      {insights.topEvents.length ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-ink-secondary">Most attended</h3>
          <ol className="flex flex-col gap-2.5">
            {insights.topEvents.map((event) => (
              <li key={event.id} className="flex flex-col gap-1">
                <span className="flex items-baseline justify-between gap-3">
                  <Link href={event.href} className="min-w-0 truncate text-sm font-semibold text-ink underline-offset-4 hover:underline">{event.title}</Link>
                  <span className="shrink-0 text-caption tabular-nums text-ink-muted">
                    {event.came} came{event.going ? ` of ${event.going}` : ""}
                  </span>
                </span>
                <span aria-hidden className="block h-1.5 w-full overflow-hidden rounded-full bg-track">
                  <span className="block h-full rounded-full bg-success-solid" style={{ width: `${Math.max(4, Math.round((event.came / largest) * 100))}%` }} />
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="text-body-ui text-ink-muted">Insights appear once your events have check-ins.</p>
      )}
    </section>
  );
}

/* ---------- Revenue ---------- */

/** Money taken across the organisation's events and series, per currency, with the top earners. */
export function OrgRevenuePanel({ organisationSlug, revenue }: { organisationSlug: string; revenue: NonNullable<OrgDashboard["revenue"]> }) {
  const months = Math.round(revenue.windowDays / 30);
  return (
    <section aria-labelledby="org-revenue-title" className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-5">
      <div>
        <h2 id="org-revenue-title" className="text-h4 text-ink">Money</h2>
        <p className="text-caption text-ink-muted">Orders placed in the last {months} months, after refunds. Each event and series has the full breakdown in its dashboard.</p>
      </div>
      {revenue.currencies.map(({ currency, summary, top }) => {
        const money = (minor: number) => formatMoney(minor, currency);
        const largest = Math.max(1, ...top.map((row) => row.netMinor));
        return (
          <div key={currency} className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Collected", money(summary.collectedMinor)],
                ["Refunded", money(summary.refundedMinor + summary.refundPendingMinor)],
                ["Net", money(summary.netMinor)],
                ["Paid orders", String(summary.orders.paid)],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-col-reverse gap-0.5">
                  <dt className="text-caption text-ink-muted">{label}</dt>
                  <dd className="font-display text-xl font-semibold text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            {summary.owedAtDeskMinor > 0 || summary.disputes.open > 0 || summary.test.payments > 0 ? (
              <p className="text-caption text-ink-muted">
                {summary.owedAtDeskMinor > 0 ? `${money(summary.owedAtDeskMinor)} to collect at the desk. ` : ""}
                {summary.disputes.open > 0 ? `${summary.disputes.open} open ${summary.disputes.open === 1 ? "chargeback" : "chargebacks"}. ` : ""}
                {summary.test.payments > 0 ? `${money(summary.test.collectedMinor - summary.test.refundedMinor)} in test payments, not counted above.` : ""}
              </p>
            ) : null}
            {top.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {top.map((row) => (
                  <li key={row.href} className="grid grid-cols-[minmax(0,1fr)_minmax(0,8rem)_auto] items-center gap-3">
                    <Link href={`/dashboard/${organisationSlug}/${row.href}`} className="truncate text-sm font-semibold text-ink hover:underline">{row.title}</Link>
                    <span aria-hidden className="block h-2.5 w-full overflow-hidden rounded-full bg-track">
                      <span className="block h-full rounded-full bg-accent-text" style={{ width: `${Math.max(2, Math.round((Math.max(0, row.netMinor) / largest) * 100))}%` }} />
                    </span>
                    <span className="text-right text-sm tabular-nums text-ink">{money(row.netMinor)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
