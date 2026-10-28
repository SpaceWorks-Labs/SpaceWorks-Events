import type { HelpSectionEntry } from "../manifest";

export const events = {
  id: "events",
  title: "Creating events",
  description: "Create, set up, publish and share events and recurring series.",
  access: "public",
  articles: [
    { slug: "events/create", title: "Creating an event", summary: "The Create event dialog and what to do next." },
    { slug: "events/event-dashboard", title: "The event dashboard", summary: "A tour of the tabs you use to run an event." },
    { slug: "events/details", title: "Event details", summary: "Title, dates, time zone, location, online events, accent colour and cover." },
    { slug: "events/cover-photo", title: "The cover photo editor", summary: "Crop, straighten and adjust your cover before it goes live." },
    { slug: "events/publishing", title: "Publishing and visibility", summary: "Draft, Live and Offline; who can find the event; and sign-up rules." },
    { slug: "events/sharing", title: "Sharing your event", summary: "Event links, short links, social cards and the embeddable event card." },
    { slug: "events/clone-cancel-delete", title: "Cloning, cancelling and deleting", summary: "Reuse an event as a template, call one off, or remove it." },
    { slug: "events/recurring-series", title: "Recurring series", summary: "Weekly meetups and other repeating events, each date with its own guest list." },
  ],
} as const satisfies HelpSectionEntry;
