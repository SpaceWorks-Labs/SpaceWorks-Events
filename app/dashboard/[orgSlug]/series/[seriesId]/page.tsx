import { loadSeriesManageView } from "@/lib/views/app__dashboard__orgSlug__series__seriesId__page";
import { EditSeriesForm } from "@/components/series/EditSeriesForm";
import { SeriesInvitePanel } from "@/components/invites/SeriesInvitePanel";
import { GuestsPeople } from "@/components/event-dashboard/panels/GuestsPeople";
import { ScheduleManager } from "@/components/schedule/ScheduleManager";
import { SeriesDatesManager } from "@/components/series/SeriesDatesManager";
import { MoneyCard } from "@/components/event-dashboard/analytics/AnalyticsSections";
import { hasRevenue } from "@/lib/payments/revenueMetrics";
import { TicketTypesManager } from "@/components/event-dashboard/settings/TicketTypesManager";
import { AddOnsManager } from "@/components/event-dashboard/settings/AddOnsManager";
import { PromoCodesManager, RefundPolicyControl, TransfersControl } from "@/components/event-dashboard/settings/PromoCodesManager";
import { EventReportDownloadButton } from "@/components/reports/EventReportDownloadButton";
import { Card, PageHeader } from "@/components/ui/display";
import { formatDayTime } from "@/lib/format/datetime";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Manage event series", robots: { index: false, follow: false } };

type Props = { params: Promise<{ orgSlug: string; seriesId: string; }>; };


function eventDateInput(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export default async function SeriesManagePage({ params }: Props) {
  const { series, isAdmin, organisation, canManageInvites, invites, canManageSchedule, canDownloadReports, finishedInstances, firstInstanceId, now, attendeesPage, rollup, dates, tickets, revenue } = await loadSeriesManageView({ params });
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={series.title} description="Manage this recurring event and its upcoming occurrences." />

      <Card as="section" padding="lg" aria-labelledby="series-details-title">
        <h2 id="series-details-title" className="mb-4 text-h4 text-ink">Series details</h2>
        {isAdmin ? <EditSeriesForm organisationSlug={organisation.slug} series={{
          id: series.id,
          title: series.title,
          description: series.description,
          recurrenceRule: series.recurrenceRule,
          timezone: series.timezone,
          capacity: series.capacity,
          status: series.status,
          privacyType: series.privacyType,
        }} /> : <p className="text-body-ui text-ink-muted">Only organisation owners and admins can edit this series.</p>}
      </Card>

      {canManageInvites ? <section aria-labelledby="series-invites-title" className="flex flex-col gap-3">
        <h2 id="series-invites-title" className="text-h4 text-ink">Invites</h2>
        <SeriesInvitePanel
          organisationSlug={organisation.slug}
          eventSeriesId={series.id}
          invites={invites.map((i) => ({
            ...i,
            createdAt: i.createdAt.toISOString(),
          }))}
        />
      </section> : null}

      {canManageSchedule ? <ScheduleManager organisationSlug={organisation.slug} eventSeriesId={series.id} items={series.scheduleItems.map((item) => ({ ...item, startDateTime: item.startDateTime.toISOString(), endDateTime: item.endDateTime.toISOString() }))} defaultDate={series.instances[0] ? eventDateInput(series.instances[0].startDateTime, series.timezone) : ""} /> : null}

      <section aria-labelledby="series-instances-title" className="flex flex-col gap-3">
        <h2 id="series-instances-title" className="text-h4 text-ink">Upcoming dates</h2>
        <SeriesDatesManager organisationSlug={organisation.slug} seriesId={series.id} seriesCapacity={series.capacity} timeZone={series.timezone} dates={dates} canManage={isAdmin} />
      </section>

      {tickets ? (
        <section aria-label="Tickets and passes" className="flex flex-col gap-5">
          <TicketTypesManager
            organisationSlug={organisation.slug}
            target={{ seriesId: series.id }}
            tickets={tickets.tickets}
            currency={tickets.currency}
            paidAllowed={tickets.paidAllowed}
            paidBlockedReason={tickets.paidBlockedReason}
            payee={tickets.payee}
          />
          <AddOnsManager organisationSlug={organisation.slug} target={{ seriesId: series.id }} currency={tickets.currency} addOns={tickets.addOns} paidAllowed={tickets.paidAllowed} />
          <PromoCodesManager organisationSlug={organisation.slug} target={{ seriesId: series.id }} currency={tickets.currency} promoCodes={tickets.promoCodes} tickets={tickets.tickets} />
          {tickets.tickets.length > 0 ? <TransfersControl organisationSlug={organisation.slug} target={{ seriesId: series.id }} transfers={tickets.transfers} /> : null}
          {tickets.tickets.some((ticket) => ticket.priceMinor > 0) ? (
            <RefundPolicyControl organisationSlug={organisation.slug} target={{ seriesId: series.id }} policy={tickets.refundPolicy} sold={tickets.sold} />
          ) : null}
        </section>
      ) : null}

      {revenue && hasRevenue(revenue) ? <MoneyCard revenue={revenue} title="Money across the series" exportHref={`/api/exports/series/${series.id}/orders`} /> : null}

      {canDownloadReports ? (
        <section aria-labelledby="series-reports-title" className="flex flex-col gap-3">
          <h2 id="series-reports-title" className="text-h4 text-ink">Reports</h2>
          {rollup ? (
            <Card>
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-h4 text-ink">Attendance across occurrences</h3>
                <span className="text-caption text-ink-muted">
                  {rollup.totalCame} check-ins{rollup.averageTurnout != null ? ` · ${rollup.averageTurnout}% average turnout` : ""}
                </span>
              </div>
              <ul className="flex flex-col gap-3">
                {rollup.rows.map((row) => (
                  <li key={row.id} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3">
                    <span className="text-sm text-ink-secondary">{formatDayTime(row.start, series.timezone)}</span>
                    <span aria-hidden className="relative block h-2.5 w-full overflow-hidden rounded-full bg-track">
                      <span className="absolute inset-y-0 left-0 rounded-full bg-accent-soft" style={{ width: `${Math.round((row.going / Math.max(1, ...rollup.rows.map((r) => r.going))) * 100)}%` }} />
                      <span className="absolute inset-y-0 left-0 rounded-full bg-success-solid" style={{ width: `${Math.round((row.came / Math.max(1, ...rollup.rows.map((r) => r.going))) * 100)}%` }} />
                    </span>
                    <span className="text-right text-sm tabular-nums text-ink">
                      {row.came} of {row.going}
                      {row.turnout != null ? <span className="block text-caption text-ink-muted">{row.turnout}% came</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          <Card>
            {finishedInstances.length ? (
              <ul className="flex flex-col divide-y divide-line">
                {finishedInstances.map((instance) => (
                  <li key={instance.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-body-ui text-ink">{formatDayTime(instance.startDateTime, series.timezone)}</span>
                    <EventReportDownloadButton href={`/api/reports/instance/${instance.id}`} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body-ui text-ink-muted">Reports become available after an occurrence has finished.</p>
            )}
          </Card>
        </section>
      ) : null}

      {firstInstanceId && attendeesPage ? (
        <section aria-label="Attendees (next date)" className="min-w-0">
          <GuestsPeople
            organisationSlug={organisation.slug}
            target={{ kind: "instance", instanceId: firstInstanceId, seriesId: series.id }}
            title="Attendees (next date)"
            timeZone={series.timezone}
            now={now.toISOString()}
            initialPage={attendeesPage}
            registrationFields={[]}
          />
        </section>
      ) : null}
    </div>
  );
}
