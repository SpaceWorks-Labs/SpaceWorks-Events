import { loadRouteMetadata } from "@/lib/views/app__orgSlug__eventSlug__page";
import { loadEventView } from "@/lib/views/app__orgSlug__eventSlug__page";
import type { Metadata } from "next";
import { EventPrivacyType } from "@prisma/client";
import { EventWebsiteShell } from "@/components/event/EventWebsiteShell";
import { normalizeSections } from "@/components/event-dashboard/event-page/summary";
import { effectiveEventProgram } from "@/lib/eventProgram";
import { plainTextToSafeHtml, sanitizeRichText } from "@/lib/richText";
import { isRegistrationClosed } from "@/lib/registrationCutoff";
import { toFieldDefinition } from "@/lib/registrationFields";
import { publicTeamRegistrationConfig } from "@/lib/publicTeamConfig";

type Props = { params: Promise<{ orgSlug: string; eventSlug: string; }>; };

export async function generateMetadata({ params }: Props): Promise<Metadata> { return loadRouteMetadata({ params }); }

export default async function EventPage({ params }: Props) {
  const { judging, mentors, org, preview, event, page, highlights, sessions, speakers, sponsors, faqs, resources, form, confirmed, viewerRsvp, held, tickets, paidSalesOpen, ticketing, crew, crewCount } = await loadEventView({ params });
  return (
    <EventWebsiteShell
      orgSlug={org.slug}
      organisation={{ name: org.name, logoUrl: org.logoUrl }}
      preview={preview}
      event={{
        slug: event.slug,
        title: event.title,
        coverImageUrl: event.coverImageUrl,
        location: event.location,
        isOnline: event.isOnline,
        status: event.status,
        start: event.startDateTime.toISOString(),
        end: event.endDateTime.toISOString(),
        timezone: event.timezone,
        capacity: event.capacity,
      }}
      page={{
        tagline: page?.tagline ?? "",
        logoUrl: page?.logoUrl ?? null,
        accentColor: page?.accentColor ?? null,
        aboutHtml: page?.aboutHtml
          ? sanitizeRichText(page.aboutHtml)
          : plainTextToSafeHtml(event.description),
        // Sections the organiser never saved show by default, as in the editor.
        sections: normalizeSections(page?.sections),
      }}
      highlights={highlights}
      sessions={effectiveEventProgram(sessions).map((session) => ({
        id: session.id,
        slug: session.slug,
        title: session.title,
        start: session.effectiveStartDateTime.toISOString(),
        end: session.effectiveEndDateTime.toISOString(),
        type: session.type,
        trackId: session.trackId,
        trackName: session.track.name,
        trackSortOrder: session.track.sortOrder,
        speakers: session.speakers.map((speaker) => ({
          slug: speaker.speaker.slug,
          name: speaker.speaker.name,
        })),
      }))}
      speakers={speakers}
      sponsors={sponsors}
      venue={
        event.location || event.mapLinkUrl
          ? { location: event.location, mapLinkUrl: event.mapLinkUrl }
          : null
      }
      faqs={faqs.map((faq) => ({
        ...faq,
        answerHtml: sanitizeRichText(faq.answerHtml),
      }))}
      resources={resources.map((resource) => ({
        id: resource.id,
        title: resource.title,
        description: resource.description,
        href: resource.externalUrl!,
      }))}
      crew={crew}
      registrationFields={(form?.fields ?? []).map(toFieldDefinition)}
      confirmedCount={event.showRegistrationCount ? confirmed : null}
      crewCount={crewCount}
      registrationOpen={
        event.status === "PUBLISHED" &&
        event.endDateTime > new Date() &&
        !isRegistrationClosed(event)
      }
      // Seats held while attendees pay count as taken.
      registrationFull={event.capacity != null && confirmed + held >= event.capacity}
      heldCount={held}
      tickets={tickets}
      paidSalesOpen={paidSalesOpen}
      ticketing={ticketing}
      approvalRequired={event.privacyType === EventPrivacyType.APPROVAL_REQUIRED}
      applications={event.admissionEnabled}
      viewerRsvp={viewerRsvp ? { token: viewerRsvp.checkInToken, status: viewerRsvp.status } : null}
      team={publicTeamRegistrationConfig(event)}
      judging={judging}
      mentors={mentors}
    />
  );
}
