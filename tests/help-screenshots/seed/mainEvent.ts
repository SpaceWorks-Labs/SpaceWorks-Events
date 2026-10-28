import { ContentVisibility, EventPageSectionType, EventPrivacyType, EventStatus, SponsorTier } from "@prisma/client";
import { HOUR, MINUTE, TIMEZONE, assetUrl, avatarSvg, daysFromNow, slugify, sponsorSvg, storeImage, type Db } from "./common";
import { coverImage, type People } from "./people";

/** The main published event: a full public page, a two-track programme and speakers. */
export async function seedMainEvent(prisma: Db, people: People, now: number) {
  const { org } = people;
  const start = daysFromNow(now, 14, 17);
  const main = await prisma.event.create({
    data: {
      organisationId: org.id,
      title: "Riverside Tech Night: Building for the Web",
      slug: "tech-night-web",
      description: "An evening of short talks, a hands-on workshop and pizza with Riverside's web developers. Everyone is welcome, from first-time coders to seasoned engineers.",
      tags: ["web", "meetup", "workshop"],
      coverImageUrl: await coverImage(prisma, org.id, "#0f766e", "#f59e0b"),
      startDateTime: start,
      endDateTime: new Date(start.getTime() + 4 * HOUR),
      timezone: TIMEZONE,
      location: "Riverside Library, 12 Quay Street, Riverside",
      capacity: 100,
      registrationLeadMinutes: 120,
      status: EventStatus.PUBLISHED,
      privacyType: EventPrivacyType.PUBLIC,
      shortCode: "RvTech7",
      createdAt: new Date(now - 30 * 24 * HOUR),
      page: {
        create: {
          isPublished: true,
          tagline: "Talks, a workshop and pizza for Riverside's web makers",
          accentColor: "#0f766e",
          aboutHtml: "<p>Join us for an evening of short talks and a hands-on workshop on building fast, accessible websites. Bring a laptop if you want to follow along.</p>",
          sections: {
            create: [
              EventPageSectionType.HERO,
              EventPageSectionType.ABOUT,
              EventPageSectionType.HIGHLIGHTS,
              EventPageSectionType.SCHEDULE,
              EventPageSectionType.SPEAKERS,
              EventPageSectionType.SPONSORS,
              EventPageSectionType.VENUE,
              EventPageSectionType.FAQ,
            ].map((type, sortOrder) => ({ type, sortOrder, isVisible: true })),
          },
        },
      },
      highlights: {
        create: [
          { title: "Three lightning talks", description: "Short, practical talks from local developers.", icon: "mic", visibility: ContentVisibility.PUBLISHED, sortOrder: 0 },
          { title: "Hands-on workshop", description: "Build an accessible form from scratch.", icon: "laptop", visibility: ContentVisibility.PUBLISHED, sortOrder: 1 },
          { title: "Pizza and networking", description: "Meet the Riverside tech community.", icon: "pizza", visibility: ContentVisibility.PUBLISHED, sortOrder: 2 },
        ],
      },
      faqs: {
        create: [
          { question: "Is the event free?", answerHtml: "<p>Yes. Registration is free, but places are limited.</p>", visibility: ContentVisibility.PUBLISHED, sortOrder: 0 },
          { question: "Do I need to bring a laptop?", answerHtml: "<p>Only for the workshop. The talks need nothing but curiosity.</p>", visibility: ContentVisibility.PUBLISHED, sortOrder: 1 },
          { question: "Is the venue accessible?", answerHtml: "<p>Yes, with step-free access and a hearing loop.</p>", visibility: ContentVisibility.PUBLISHED, sortOrder: 2 },
        ],
      },
      venue: {
        create: {
          name: "Riverside Library",
          address: "12 Quay Street",
          city: "Riverside",
          country: "United Kingdom",
          directions: "Enter through the main doors and take the lift to the first floor.",
          accessibilityInfo: "Step-free access and a hearing loop in the Main Hall.",
          visibility: ContentVisibility.PUBLISHED,
        },
      },
    },
  });

  const speakerData = [
    { name: "Imogen Clarke", headline: "Front-end engineer", organisation: "Harbour Digital", initials: "IC", colour: "#0f766e" },
    { name: "Kwame Asante", headline: "Accessibility specialist", organisation: "Open Web Co-op", initials: "KA", colour: "#7c3aed" },
    { name: "Lucía Romero", headline: "Performance engineer", organisation: "Riverside Council", initials: "LR", colour: "#c2410c" },
  ];
  const speakers = [];
  for (const [index, speaker] of speakerData.entries()) {
    const photo = await storeImage(prisma, { organisationId: org.id }, "event-speakers", avatarSvg(speaker.initials, speaker.colour), 256, 256);
    speakers.push(
      await prisma.eventSpeaker.create({
        data: {
          eventId: main.id, name: speaker.name, slug: slugify(speaker.name), headline: speaker.headline, organisation: speaker.organisation,
          photoUrl: assetUrl(photo), bioHtml: `<p>${speaker.name} builds for the web and loves sharing what works.</p>`, visibility: ContentVisibility.PUBLISHED, sortOrder: index,
        },
      }),
    );
  }
  const sponsorData = [
    { name: "Harbour Digital", tier: SponsorTier.GOLD, colour: "#0ea5e9" },
    { name: "Quay Coffee", tier: SponsorTier.SILVER, colour: "#a16207" },
    { name: "Open Web Co-op", tier: SponsorTier.COMMUNITY_PARTNER, colour: "#16a34a" },
  ];
  for (const [index, sponsor] of sponsorData.entries()) {
    const logo = await storeImage(prisma, { organisationId: org.id }, "event-sponsors", sponsorSvg(sponsor.name, sponsor.colour), 480, 240);
    await prisma.eventSponsor.create({
      data: { eventId: main.id, name: sponsor.name, tier: sponsor.tier, logoUrl: assetUrl(logo), websiteUrl: "https://example.org", visibility: ContentVisibility.PUBLISHED, sortOrder: index },
    });
  }

  // Two tracks; the Main Hall runs 15 minutes late from its second session.
  const mainHall = await prisma.eventScheduleTrack.create({ data: { eventId: main.id, name: "Main Hall", sortOrder: 0 } });
  const workshop = await prisma.eventScheduleTrack.create({ data: { eventId: main.id, name: "Workshop Room", sortOrder: 1 } });
  const at = (minutes: number) => new Date(start.getTime() + minutes * MINUTE);
  const sessions = [
    { track: mainHall, title: "Welcome and introductions", type: "Talk", start: 0, end: 15, speakers: [] as number[] },
    { track: mainHall, title: "Shipping less JavaScript", type: "Talk", start: 15, end: 45, speakers: [2], delay: 15 },
    { track: mainHall, title: "Designing for screen readers", type: "Talk", start: 45, end: 75, speakers: [1] },
    { track: mainHall, title: "Community lightning talks", type: "Lightning talks", start: 75, end: 105, speakers: [] },
    { track: workshop, title: "Workshop: accessible forms", type: "Workshop", start: 30, end: 120, speakers: [0, 1] },
    { track: workshop, title: "Code review clinic", type: "Workshop", start: 120, end: 180, speakers: [0] },
    { track: mainHall, title: "Pizza and networking", type: "Break", start: 105, end: 180, speakers: [] },
  ];
  for (const [index, session] of sessions.entries()) {
    const created = await prisma.eventSession.create({
      data: {
        eventId: main.id, trackId: session.track.id, title: session.title, slug: slugify(session.title), type: session.type,
        startDateTime: at(session.start), endDateTime: at(session.end), delayMinutes: session.delay ?? 0,
        visibility: ContentVisibility.PUBLISHED, sortOrder: index, descriptionHtml: `<p>${session.title}.</p>`,
      },
    });
    for (const [order, speakerIndex] of session.speakers.entries()) {
      await prisma.eventSessionSpeaker.create({ data: { eventSessionId: created.id, speakerId: speakers[speakerIndex]!.id, sortOrder: order } });
    }
  }
  return main;
}
