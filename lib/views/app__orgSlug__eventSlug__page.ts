import { eventForView } from "@/lib/frontend/eventView";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ContentVisibility, EventPageSectionType, EventPrivacyType, RegistrationMode } from "@prisma/client";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { isEventPublished, shouldIndexPublicEvent } from "@/lib/eventVisibility";
import { resolvePublicEventAccess } from "@/lib/publicEventAccess";
import { countConfirmedForEvent, countHeldForEvent } from "@/lib/rsvpCapacity";
import { listPublicTicketTypes } from "@/lib/payments/tickets";
import { DEFAULT_CURRENCY } from "@/lib/payments/money";
import { canAcceptOnlinePayments } from "@/lib/payments/settings";
import { isProjectGalleryVisible } from "@/lib/core/judging";
import { projectGalleryPath, resultsPath } from "@/lib/submissionToken";
import { ticketingInfo, viewerIsMember } from "@/lib/payments/ticketing";
import { countCrewTickets, listPublicCrew } from "@/lib/core/crew";
type Props = { params: Promise<{ orgSlug: string; eventSlug: string; }>; };
export async function loadRouteMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, eventSlug } = await params;
  const org = await prisma.organisation.findUnique({
    where: { slug: orgSlug },
  });
  const event = org
    ? await prisma.event.findUnique({
      where: {
        organisationId_slug: { organisationId: org.id, slug: eventSlug },
      },
    })
    : null;
  const page = event
    ? await prisma.eventPage.findUnique({
      where: { eventId: event.id },
      select: { isPublished: true },
    })
    : null;
  if (
    !event ||
    !page?.isPublished ||
    !isEventPublished(event.status) ||
    event.privacyType === EventPrivacyType.INVITE_ONLY
  )
    return { title: "Event", robots: { index: false, follow: false } };
  const description = event.description.slice(0, 160) || event.title;
  return {
    title: event.title,
    description,
    alternates: { canonical: `/${org!.slug}/${event.slug}` },
    robots: shouldIndexPublicEvent(event.status, event.privacyType, event.listedPublicly)
      ? undefined
      : { index: false, follow: false },
    openGraph: {
      title: event.title,
      description,
      type: "website",
      // Without a cover, leave `images` out so the generated share card (opengraph-image.tsx) is used.
      ...(event.coverImageUrl ? { images: [{ url: event.coverImageUrl }] } : {}),
    },
  };
}
export async function loadEventView({ params }: Props) {
  const { orgSlug, eventSlug } = await params;
  const org = await prisma.organisation.findUnique({
    where: { slug: orgSlug },
  });
  if (!org) notFound();
  const event = await prisma.event.findUnique({
    where: { organisationId_slug: { organisationId: org.id, slug: eventSlug } },
  });
  if (!event) notFound();
  const release = await prisma.eventPage.findUnique({
    where: { eventId: event.id },
    select: { isPublished: true },
  });
  const access = await resolvePublicEventAccess({
    organisationId: org.id,
    eventId: event.id,
    status: event.status,
    privacyType: event.privacyType,
    websiteReleased: release?.isPublished ?? false,
  });
  if (!access.allowed) notFound();
  const preview = access.preview;
  const published = { visibility: ContentVisibility.PUBLISHED };
  const [
    page,
    highlights,
    sessions,
    speakers,
    sponsors,
    faqs,
    resources,
    form,
    confirmed,
    viewerRsvp,
    held,
    tickets,
  ] = await Promise.all([
    prisma.eventPage.findUnique({
      where: { eventId: event.id },
      include: { sections: { orderBy: { sortOrder: "asc" } } },
    }),
    prisma.eventHighlight.findMany({
      where: { eventId: event.id, ...published },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.eventSession.findMany({
      where: { eventId: event.id, ...published },
      include: {
        track: true,
        speakers: {
          where: { speaker: { visibility: ContentVisibility.PUBLISHED } },
          include: { speaker: true },
        },
      },
      orderBy: [{ startDateTime: "asc" }, { sortOrder: "asc" }],
    }),
    prisma.eventSpeaker.findMany({
      where: { eventId: event.id, ...published },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.eventSponsor.findMany({
      where: { eventId: event.id, ...published },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.eventFaq.findMany({
      where: { eventId: event.id, ...published },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.eventResource.findMany({
      where: { eventId: event.id, ...published, externalUrl: { not: null } },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.eventRegistrationForm.findUnique({
      where: { eventId: event.id },
      include: { fields: { orderBy: { sortOrder: "asc" } } },
    }),
    countConfirmedForEvent(event.id, event.registrationMode),
    auth().then((session) =>
      session?.user?.id
        ? prisma.rSVP.findFirst({
          where: { eventId: event.id, userId: session.user.id },
          select: { checkInToken: true, status: true },
        })
        : null,
    ),
    countHeldForEvent(event.id),
    // Members also see members-only tickets.
    viewerIsMember(org.id).then((member) => listPublicTicketTypes({ eventId: event.id }, event.currency ?? DEFAULT_CURRENCY, new Date(), { member })),
  ]);
  // Crew (docs/CREW.md): cards only when the saved CREW section is on (pages
  // without saved sections keep it off), and crew tickets counted as "going"
  // only where the count is shown and the wording is per person.
  const crewSectionOn = page?.sections.some((section) => section.type === EventPageSectionType.CREW && section.isVisible) ?? false;
  const [crew, crewCount] = await Promise.all([
    crewSectionOn ? listPublicCrew(event.id) : Promise.resolve([]),
    event.showRegistrationCount && event.registrationMode !== RegistrationMode.TEAM ? countCrewTickets(event.id) : Promise.resolve(null),
  ]);
  // What the form needs beyond the tickets: codes, add-ons, the refund terms.
  const ticketing = await ticketingInfo({ eventId: event.id }, tickets, event.currency ?? DEFAULT_CURRENCY, event);
  // Paid tickets are on sale only while the installation allows it and the
  // organisation's account is fully connected.
  const paidSalesOpen = ticketing?.sellsPaid ? await canAcceptOnlinePayments(org.id) : false;
  // Hackathon pages (docs/HACKATHON.md): linked only once each is live.
  const judging = {
    resultsHref: event.submissionsEnabled && event.resultsPublishedAt ? resultsPath(org.slug, event.slug) : null,
    projectsHref: isProjectGalleryVisible(event) ? projectGalleryPath(org.slug, event.slug) : null,
  };
  return { judging, org, preview, event: eventForView(event), page, highlights, sessions, speakers, sponsors, faqs, resources, form, confirmed, viewerRsvp, held, tickets, paidSalesOpen, ticketing, crew, crewCount };
}
