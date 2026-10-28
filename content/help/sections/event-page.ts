import type { HelpSectionEntry } from "../manifest";

export const eventPage = {
  id: "event-page",
  title: "Event pages and programmes",
  description: "Build the public website for your event: sections, schedule, speakers and sponsors.",
  access: "public",
  articles: [
    { slug: "event-page/building-your-page", title: "Building your event page", summary: "Sections, highlights, venue, FAQs and resources." },
    { slug: "event-page/programme", title: "Building the programme", summary: "Tracks and sessions for a public schedule." },
    { slug: "event-page/live-delays", title: "Running late: live delays", summary: "Tell guests about delays on the day without editing every session." },
    { slug: "event-page/speakers-and-sponsors", title: "Speakers and sponsors", summary: "Speaker profiles and pages, and sponsors with their tiers." },
  ],
} as const satisfies HelpSectionEntry;
