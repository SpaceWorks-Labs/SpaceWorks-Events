import { loadEventCheckInView } from "@/lib/views/app__dashboard__orgSlug__event__eventId__check-in__page";
import Link from "next/link";
import { EventCheckInClient } from "@/components/checkin/EventCheckInClient";
import { CheckInStationSettings } from "@/components/checkin/CheckInStationSettings";
import { buttonClasses } from "@/components/ui/button";
import { EventManageHeader } from "@/components/dashboard/EventManageHeader";
import { badgeBrandingFor, badgeDesignFor } from "@/lib/badge/presentation";
import { CheckInListDesk } from "@/components/checkin/CheckInListDesk";
import { CheckInListSwitcher } from "@/components/checkin/CheckInListSwitcher";

type Props = {
  params: Promise<{ orgSlug: string; eventId: string; }>;
  searchParams: Promise<{ list?: string | string[]; }>;
};

export const metadata = { title: "Event check-in", robots: { index: false, follow: false } };

export default async function EventCheckInPage({ params, searchParams }: Props) {
  const view = await loadEventCheckInView({ params, searchParams });
  const { organisation, event, listDesk } = view;
  const badgesHref = `/dashboard/${organisation.slug}/event/${event.id}/check-in/badges`;
  const header = (
    <EventManageHeader
      back={{ href: `/dashboard/${organisation.slug}/event/${event.id}`, label: "Back to event" }}
      event={{ title: event.title, status: event.status, privacyType: event.privacyType, startDateTime: event.startDateTime, timezone: event.timezone, accentColor: event.page?.accentColor }}
      actions={<Link href={badgesHref} className={buttonClasses({ variant: "secondary" })}>Badges</Link>}
    />
  );
  const switcher = listDesk.openLists.length > 0 || listDesk.canManage ? (
    <CheckInListSwitcher
      deskPath={listDesk.deskPath}
      lists={listDesk.openLists}
      selectedId={listDesk.selectedList?.id ?? null}
      manage={listDesk.canManage ? { organisationSlug: organisation.slug, eventId: event.id, lists: listDesk.lists } : null}
    />
  ) : null;

  if (view.mode === "list") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        {switcher}
        <CheckInListDesk
          key={view.selectedList.id}
          organisationSlug={organisation.slug}
          eventId={event.id}
          timeZone={event.timezone}
          list={view.selectedList}
          roster={view.roster.rows}
          rosterTruncated={view.roster.truncated}
        />
      </div>
    );
  }

  const { confirmed, stationEnabled, registrationForm, checkedInCount, recent, badgeEvent, canManageStation, stationUrl } = view;
  return (
    <div className="flex flex-col gap-6">
      {header}
      {switcher}
      <EventCheckInClient
        organisationSlug={organisation.slug}
        organisationName={organisation.name}
        eventId={event.id}
        eventTitle={event.title}
        registrationFields={registrationForm?.fields ?? []}
        teamEvent={event.registrationMode === "TEAM"}
        stats={{ confirmed, checkedIn: checkedInCount }}
        recent={recent}
        badge={{ design: badgeDesignFor(badgeEvent), branding: badgeBrandingFor(badgeEvent), canSave: true }}
      />
      {canManageStation ? <CheckInStationSettings organisationSlug={organisation.slug} eventId={event.id} stationUrl={stationUrl} enabled={stationEnabled} /> : null}
    </div>
  );
}
