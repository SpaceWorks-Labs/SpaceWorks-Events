import { loadEventScheduleManageView } from "@/lib/views/app__dashboard__orgSlug__event__eventId__schedule__page";
import { EventProgramScheduleManager } from "@/components/event/EventProgramScheduleManager";
import { EventManageHeader } from "@/components/dashboard/EventManageHeader";
import { SectionHeading } from "@/components/ui/display";
import type { Metadata } from "next";
import { HelpLink } from "@/components/help/HelpLink";

export const metadata: Metadata = { title: "Manage event schedule", robots: { index: false, follow: false } };

export default async function EventScheduleManagePage({ params }: { params: Promise<{ orgSlug: string; eventId: string; }>; }) {
  const { access, event, sessions } = await loadEventScheduleManageView({ params });
  return (
    <div className="flex flex-col gap-6">
      <EventManageHeader
        back={{ href: `/dashboard/${access.organisation.slug}/event/${event.id}`, label: "Back to event" }}
        event={{ title: event.title, status: event.status, privacyType: event.privacyType, startDateTime: event.startDateTime, timezone: event.timezone, accentColor: event.page?.accentColor }}
      />
      <SectionHeading as="h2" title="Programme schedule" description="Plan parallel tracks and manage live timing changes independently." action={<HelpLink article="event-page/programme" />} />
      <EventProgramScheduleManager organisationSlug={access.organisation.slug} eventId={event.id} eventStart={event.startDateTime.toISOString()} timeZone={event.timezone} tracks={event.scheduleTracks} sessions={sessions} speakers={event.speakers} />
    </div>
  );
}
