import { loadOrgMembersView } from "@/lib/views/app__dashboard__orgSlug__members__page";
import Link from "next/link";
import { formatRelativeTime } from "@/lib/format/datetime";
import { OrgPageHeader } from "@/components/dashboard/org/OrgPageHeader";
import { OrgInviteLinkPanel } from "@/components/members/OrgInviteLinkPanel";
import { MemberStat, RolesCard } from "@/components/members/MemberSections";
import { TeamList } from "@/components/members/TeamList";
import { roleBreakdown, roleDots } from "@/components/members/memberSummary";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/display";
import { cn } from "@/lib/cn";

import type { Metadata } from "next";
import { HelpLink } from "@/components/help/HelpLink";

type Props = { params: Promise<{ orgSlug: string; }>; searchParams: Promise<{ page?: string; }>; };

const RECENT_DAYS = 30;
/** Member join dates and invite ages carry no event context; show them in UTC so every viewer sees the same label. */
const DISPLAY_TIME_ZONE = "UTC";

export const metadata: Metadata = {
  title: "Members",
  description: "Organisation members and roles.",
};



export default async function OrgMembersPage({ params, searchParams }: Props) {
  const { organisation, profile, adminView, memberCount, roleCounts, recentCount, recentHint, openInviteCount, rows, membership, memberPages, memberPage, baseUrl, invites, now } = await loadOrgMembersView({ params, searchParams });
  return (
    <div className="flex flex-col gap-7 pb-4">
      <OrgPageHeader
        organisation={{ name: organisation.name, slug: organisation.slug, logoUrl: profile.logoUrl }}
        title="Members"
        description={`The people who run ${organisation.name}, and what each of them can do.`}
        actions={<HelpLink article="organisations/roles">Roles explained</HelpLink>}
      />

      <section aria-label="Team at a glance" className={cn("grid grid-cols-1 gap-4", adminView ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <MemberStat label="People" value={memberCount} hint={roleBreakdown(roleCounts)} dots={roleDots(roleCounts)} />
        <MemberStat label={`Joined in the last ${RECENT_DAYS} days`} value={recentCount} hint={recentHint} />
        {adminView ? <MemberStat label="Open invite links" value={openInviteCount} hint="Each link works once" /> : null}
      </section>

      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {rows.length === 0 ? (
            <EmptyState mood="sleepy">No members found.</EmptyState>
          ) : (
            <TeamList organisationSlug={organisation.slug} actorRole={membership.role} rows={rows} showEmail={adminView} />
          )}
          {memberPages > 1 ? (
            <nav aria-label="Member pages" className="flex flex-wrap items-center justify-end gap-2">
              <p className="text-sm text-ink-muted">Page {memberPage} of {memberPages}</p>
              {memberPage <= 1 ? (
                <Button size="sm" variant="secondary" disabled>Previous</Button>
              ) : (
                <Button asChild size="sm" variant="secondary"><Link href={`?page=${memberPage - 1}`}>Previous</Link></Button>
              )}
              {memberPage >= memberPages ? (
                <Button size="sm" variant="secondary" disabled>Next</Button>
              ) : (
                <Button asChild size="sm" variant="secondary"><Link href={`?page=${memberPage + 1}`}>Next</Link></Button>
              )}
            </nav>
          ) : null}
        </div>

        <aside className="flex min-w-0 flex-col gap-5">
          {adminView ? (
            <OrgInviteLinkPanel
              organisationSlug={organisation.slug}
              baseUrl={baseUrl}
              invites={invites.map((invite) => ({
                id: invite.id,
                token: invite.token,
                createdLabel: formatRelativeTime(invite.createdAt, DISPLAY_TIME_ZONE, now),
              }))}
            />
          ) : null}
          <RolesCard />
        </aside>
      </div>
    </div>
  );
}
