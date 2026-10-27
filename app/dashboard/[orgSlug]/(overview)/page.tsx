import { loadRouteMetadata } from "@/lib/views/app__dashboard__orgSlug__page";
import { loadOrgDashboardView } from "@/lib/views/app__dashboard__orgSlug__page";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { canManageMembers } from "@/lib/permissionRoles";

import { roleLabel } from "@/lib/permissionRoles";
import { CreateEventDialog } from "@/components/event/CreateEventDialog";
import { CreateSeriesDialog } from "@/components/series/CreateSeriesDialog";
import { PageHeader } from "@/components/ui/display";
import { LiveEventPanel, NextUpCard, StatRow } from "@/components/dashboard/home/HomeSections";
import { OrgBanner, OrgEventList, OrgInsightsPanel, OrgMiniCalendar, OrgRevenuePanel, OrgSeriesPanel, OrgSettingsLink, OrgSetup, OrgTeamPanel, orgHref } from "@/components/dashboard/org/OrgSections";

import type { Metadata } from "next";

type Props = {
  params: Promise<{ orgSlug: string; }>;
  searchParams: Promise<{ view?: string; q?: string; show?: string; month?: string; }>;
};



export async function generateMetadata({ params }: Props): Promise<Metadata> { return loadRouteMetadata({ params }); }

export default async function OrgDashboardPage({
  params,
  searchParams,
}: Props) {
  const view = await loadOrgDashboardView({ params, searchParams });
  const { organisation } = view;
  if (view.collaborator) {
    const { grants } = view; return (
      <div className="flex flex-col gap-6">
        <PageHeader title={organisation.name} description="Your assigned events" />
        <ul className="flex flex-col gap-2.5">
          {grants.map((grant) =>
            grant.event ? (
              <li key={grant.id}>
                <Link
                  href={`/dashboard/${organisation.slug}/event/${grant.event.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel p-4 font-semibold text-ink transition-colors hover:bg-subtle"
                >
                  {grant.event.title}
                  <ChevronRight aria-hidden className="size-4 text-ink-muted" />
                </Link>
              </li>
            ) : grant.series ? (
              <li key={grant.id}>
                <Link
                  href={`/dashboard/${organisation.slug}/series/${grant.series.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel p-4 font-semibold text-ink transition-colors hover:bg-subtle"
                >
                  {grant.series.title}
                  <ChevronRight aria-hidden className="size-4 text-ink-muted" />
                </Link>
              </li>
            ) : null,
          )}
        </ul>
      </div>
    );
  }
  const { membership, manage, admin, base, now, profile, data, effectiveQuery } = view;
  const calendar = (
    <OrgMiniCalendar
      calendar={data.calendar}
      prevHref={orgHref(base, effectiveQuery, { month: data.calendar.prevKey })}
      nextHref={orgHref(base, effectiveQuery, { month: data.calendar.nextKey })}
    />
  );

  const actions = (
    <>
      {admin ? <OrgSettingsLink href={`${base}/settings`} /> : null}
      {manage ? (
        <>
          <CreateSeriesDialog organisationSlug={organisation.slug} canPublish={manage} />
          <CreateEventDialog organisationSlug={organisation.slug} variant="button" />
        </>
      ) : null}
    </>
  );

  const banner = (
    <OrgBanner
      organisation={{ name: organisation.name, slug: organisation.slug, description: profile.description, logoUrl: profile.logoUrl }}
      role={roleLabel(membership.role)}
      memberCount={data.members.total}
      actions={actions}
    />
  );

  // A brand-new organisation: the setup checklist leads.
  if (data.setup && !data.setup.hasEvent && data.series.total === 0) {
    return (
      <div className="flex flex-col gap-7">
        {banner}
        <OrgSetup
          setup={data.setup}
          name={organisation.name}
          links={{ settings: `${base}/settings`, members: `${base}/members`, publicPage: `/${organisation.slug}` }}
          createEvent={<CreateEventDialog organisationSlug={organisation.slug} variant="button" />}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      {banner}

      {data.needsYou ? (
        <div role="status" className="flex flex-col gap-3 rounded-lg bg-warning-bg px-4 py-3.5 text-warning-fg sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-body-ui">
            {data.needsYou.pendingApprovals > 0 ? (
              <strong>{data.needsYou.pendingApprovals === 1 ? "1 person is" : `${data.needsYou.pendingApprovals} people are`} waiting for approval.</strong>
            ) : null}
            {data.needsYou.pendingApprovals > 0 && data.needsYou.drafts > 0 ? " " : null}
            {data.needsYou.drafts > 0 ? <span>{data.needsYou.drafts === 1 ? "1 event is" : `${data.needsYou.drafts} events are`} still a draft.</span> : null}
          </p>
          <span className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 text-sm font-bold">
            {data.needsYou.approvalsHref ? <Link href={data.needsYou.approvalsHref} className="underline underline-offset-4">Review approvals</Link> : null}
            {data.needsYou.draftHref ? <Link href={data.needsYou.draftHref} className="underline underline-offset-4">Finish draft</Link> : null}
          </span>
        </div>
      ) : null}

      {data.live ? <LiveEventPanel live={data.live} now={now} /> : null}

      {data.next ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <NextUpCard next={data.next} now={now} />
          {calendar}
        </div>
      ) : null}

      <StatRow stats={data.stats} />

      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <OrgEventList base={base} query={effectiveQuery} events={data.events} showDrafts={manage} now={now} />
        <aside className="flex flex-col gap-5">
          {data.next ? null : calendar}
          <OrgSeriesPanel
            base={base}
            series={data.series}
            now={now}
            action={null}
          />
          {data.insights ? <OrgInsightsPanel insights={data.insights} /> : null}
          {data.revenue ? <OrgRevenuePanel organisationSlug={organisation.slug} revenue={data.revenue} /> : null}
          <OrgTeamPanel members={data.members} membersHref={`${base}/members`} canInvite={canManageMembers(membership)} />
        </aside>
      </div>

      {manage ? (
        <div className="fixed bottom-6 right-6 z-10 md:hidden">
          <CreateEventDialog organisationSlug={organisation.slug} variant="fab" />
        </div>
      ) : null}
    </div>
  );
}
