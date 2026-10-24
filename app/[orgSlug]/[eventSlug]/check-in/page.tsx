import { loadVenueCheckInStationView } from "@/lib/views/app__orgSlug__eventSlug__check-in__page";
import { EventCheckInClient } from "@/components/checkin/EventCheckInClient";
import { CheckInStationUnlock } from "@/components/checkin/CheckInStationUnlock";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Venue check-in", robots: { index: false, follow: false }, referrer: "no-referrer" };

type Props = { params: Promise<{ orgSlug: string; eventSlug: string; }>; };

export default async function VenueCheckInStationPage({ params }: Props) {
  const data = await loadVenueCheckInStationView({ params });
  if (!data.unlocked) return <CheckInStationUnlock organisationSlug={data.orgSlug} eventSlug={data.eventSlug} />;
  const { event, fields, confirmed, checkedIn, recent, badge } = data;
  return <EventCheckInClient stationMode teamEvent={event.teamEvent} eventSlug={event.slug} organisationSlug={event.organisation.slug} organisationName={event.organisation.name} eventId={event.id} eventTitle={event.title} registrationFields={fields} stats={{ confirmed, checkedIn }} recent={recent} badge={badge} />;
}
