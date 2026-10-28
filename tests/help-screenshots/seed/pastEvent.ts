import { EventPrivacyType, EventStatus, RegistrationFieldType, RsvpStatus } from "@prisma/client";
import { DAY, HOUR, MINUTE, TIMEZONE, certificateSvg, daysFromNow, guestKey, storeImage, type Db } from "./common";
import type { People } from "./people";

const PAST_NAMES = [
  "Aisha Bello", "Bruno Costa", "Clara Weber", "Dylan Hughes", "Esme Clarke", "Felix Wagner", "Greta Lind", "Hamza Ali", "Ines Duarte", "Jonas Berg",
  "Keira Doyle", "Leo Martin", "Mila Novak", "Nathan Price", "Ola Nordmann", "Pia Jensen", "Rami Haddad", "Sara Kim", "Theo Grant", "Una Byrne",
  "Vera Petrova", "Wes Turner", "Yara Haddad", "Zoe Evans", "Arlo Reed", "Bea Fox", "Cal Moss", "Dina Rossi", "Eli Stone", "Faye Hart",
  "Gus Vale", "Hope Lane",
];

/** A past event with analytics, feedback and certificates. */
export async function seedPastEvent(prisma: Db, people: People, now: number) {
  const { org } = people;
  const start = daysFromNow(now, -21, 17, 30);
  const past = await prisma.event.create({
    data: {
      organisationId: org.id,
      title: "Riverside Tech Night: September Edition",
      slug: "tech-night-september",
      description: "Talks on testing, design systems and open data.",
      tags: ["meetup"],
      startDateTime: start,
      endDateTime: new Date(start.getTime() + 3 * HOUR),
      timezone: TIMEZONE,
      location: "Riverside Library, 12 Quay Street, Riverside",
      capacity: 60,
      status: EventStatus.PUBLISHED,
      privacyType: EventPrivacyType.PUBLIC,
      createdAt: new Date(now - 50 * DAY),
      page: { create: { isPublished: true, accentColor: "#7c3aed", aboutHtml: "<p>Our September meetup.</p>" } },
    },
  });
  const rsvps: { id: string; checkedIn: boolean }[] = [];
  for (const [index, name] of PAST_NAMES.entries()) {
    const email = `${name.toLowerCase().replace(/\s+/g, ".")}@example.org`;
    // Sign-ups cluster after the announcement and again in the final week.
    const daysBefore = index < 12 ? 24 - index * 0.6 : index < 22 ? 14 - (index - 12) * 0.5 : 6 - (index - 22) * 0.5;
    const status = index < 28 ? RsvpStatus.CONFIRMED : index < 30 ? RsvpStatus.WAITLISTED : RsvpStatus.REJECTED;
    const checkedIn = status === RsvpStatus.CONFIRMED && index % 5 !== 3;
    const rsvp = await prisma.rSVP.create({
      data: {
        eventId: past.id, guestEmail: email, guestName: name, attendeeKey: guestKey(email), status,
        createdAt: new Date(start.getTime() - daysBefore * DAY), checkedInAt: checkedIn ? new Date(start.getTime() + (index % 40) * MINUTE) : null,
      },
      select: { id: true },
    });
    rsvps.push({ id: rsvp.id, checkedIn });
  }

  const background = await storeImage(prisma, { organisationId: org.id }, "certificate-backgrounds", certificateSvg(), 1600, 1131);
  const certificateTemplate = {
    version: 2,
    backgroundKey: background,
    elements: [
      { id: "heading", type: "text", text: "Certificate of attendance", x: 10, y: 16, width: 80, height: 10, font: "serif", fontSize: 54, color: "#0f766e", bold: true, italic: false, uppercase: true, letterSpacing: 6, align: "center" },
      { id: "name", type: "text", text: "{{name}}", x: 10, y: 36, width: 80, height: 12, font: "serif", fontSize: 72, color: "#1f2937", bold: false, italic: true, uppercase: false, letterSpacing: 0, align: "center" },
      { id: "event", type: "text", text: "attended {{event}}", x: 10, y: 54, width: 80, height: 8, font: "sans", fontSize: 30, color: "#374151", bold: false, italic: false, uppercase: false, letterSpacing: 0, align: "center" },
      { id: "date", type: "text", text: "{{eventDate}} · {{organisation}}", x: 10, y: 64, width: 80, height: 6, font: "sans", fontSize: 22, color: "#6b7280", bold: false, italic: false, uppercase: false, letterSpacing: 2, align: "center" },
    ],
  };
  const form = await prisma.eventFeedbackForm.create({
    data: {
      eventId: past.id, isOpen: true, title: "How was Tech Night?", thankYouMessage: "Thank you! Your certificate is ready to download.",
      certificateEnabled: true, certificateTemplate,
      fields: {
        create: [
          { key: "rating", label: "How would you rate the evening?", type: RegistrationFieldType.RADIO, required: true, sortOrder: 0, options: ["Excellent", "Good", "Okay", "Poor"] },
          { key: "favourite", label: "Which talk did you enjoy most?", type: RegistrationFieldType.SELECT, required: false, sortOrder: 1, options: ["Testing without tears", "Design systems at scale", "Open data for good"] },
          { key: "improve", label: "What could we do better?", type: RegistrationFieldType.TEXTAREA, required: false, sortOrder: 2 },
        ],
      },
    },
    include: { fields: true },
  });
  const answers = [
    ["Excellent", "Open data for good", "More time for questions, please."],
    ["Good", "Testing without tears", "A bigger room."],
    ["Excellent", "Design systems at scale", "Nothing, it was great."],
    ["Good", "Open data for good", "Vegan pizza options."],
    ["Okay", "Testing without tears", "Start a little later."],
  ];
  const attended = rsvps.filter((rsvp) => rsvp.checkedIn);
  for (const [index, values] of answers.entries()) {
    await prisma.eventFeedbackResponse.create({
      data: {
        formId: form.id, rsvpId: attended[index]!.id, certificateTemplate, submittedAt: new Date(start.getTime() + (1 + index) * DAY),
        answers: { create: form.fields.map((field, fieldIndex) => ({ fieldId: field.id, fieldKey: field.key, fieldLabel: field.label, fieldType: field.type, valueText: values[fieldIndex] })) },
      },
    });
  }
  return past;
}

/** A draft for the readiness checklist, more public events for Discover, and a weekly series. */
export async function seedOtherEvents(prisma: Db, people: People, now: number) {
  const { org, other } = people;
  const draftStart = daysFromNow(now, 45, 9);
  const draft = await prisma.event.create({
    data: {
      organisationId: org.id, title: "Community Open Data Day", slug: "open-data-day", description: "A day of exploring Riverside's open data together.", tags: ["open data"],
      startDateTime: draftStart, endDateTime: new Date(draftStart.getTime() + 7 * HOUR), timezone: TIMEZONE, location: "Riverside Town Hall", capacity: 80,
      status: EventStatus.DRAFT, privacyType: EventPrivacyType.PUBLIC, page: { create: { isPublished: false } },
    },
  });
  const discover = [
    { title: "Intro to Python for Beginners", slug: "python-beginners", days: 5, tags: ["python", "workshop"], location: "Riverside Library" },
    { title: "Design Systems Meetup", slug: "design-systems", days: 9, tags: ["design"], location: "Harbour Studios" },
    { title: "Women in Tech Breakfast", slug: "women-in-tech-breakfast", days: 17, tags: ["community"], location: "Quay Coffee" },
  ];
  for (const item of discover) {
    const start = daysFromNow(now, item.days, 18);
    await prisma.event.create({
      data: {
        organisationId: org.id, title: item.title, slug: item.slug, description: `${item.title} with the Riverside Tech Collective.`, tags: item.tags,
        startDateTime: start, endDateTime: new Date(start.getTime() + 2 * HOUR), timezone: TIMEZONE, location: item.location, capacity: 40,
        status: EventStatus.PUBLISHED, privacyType: EventPrivacyType.PUBLIC, page: { create: { isPublished: true, accentColor: "#0f766e" } },
      },
    });
  }
  const repairStart = daysFromNow(now, 11, 10);
  await prisma.event.create({
    data: {
      organisationId: other.id, title: "Repair Café: Fix Your Gadgets", slug: "repair-cafe", description: "Bring broken electronics and fix them with help from volunteers.", tags: ["hardware", "repair"],
      startDateTime: repairStart, endDateTime: new Date(repairStart.getTime() + 4 * HOUR), timezone: TIMEZONE, location: "Northside Community Centre", capacity: 30,
      status: EventStatus.PUBLISHED, privacyType: EventPrivacyType.PUBLIC, page: { create: { isPublished: true, accentColor: "#b45309" } },
    },
  });

  // Weekly on Thursdays, starting with the next one.
  const seriesStart = new Date(now + ((4 - new Date(now).getUTCDay() + 7) % 7 || 7) * DAY);
  seriesStart.setUTCHours(18, 0, 0, 0);
  const stamp = seriesStart.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const series = await prisma.eventSeries.create({
    data: {
      organisationId: org.id, title: "Thursday Code Club", slug: "code-club", description: "A relaxed weekly session to work on your own projects with friendly help.",
      recurrenceRule: `DTSTART:${stamp}\nRRULE:FREQ=WEEKLY;COUNT=4`, instanceDurationMs: 2 * HOUR, timezone: TIMEZONE, privacyType: EventPrivacyType.PUBLIC, capacity: 25, status: EventStatus.PUBLISHED,
    },
  });
  for (let week = 0; week < 4; week++) {
    const start = new Date(seriesStart.getTime() + week * 7 * DAY);
    await prisma.eventInstance.create({ data: { eventSeriesId: series.id, startDateTime: start, endDateTime: new Date(start.getTime() + 2 * HOUR) } });
  }
  return { draft, series };
}
