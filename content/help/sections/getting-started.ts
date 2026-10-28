import type { HelpSectionEntry } from "../manifest";

export const gettingStarted = {
  id: "getting-started",
  title: "Getting started",
  description: "What Space Works Events is, the words it uses, and your first event from start to finish.",
  access: "public",
  articles: [
    { slug: "getting-started/welcome", title: "Welcome to Space Works Events", summary: "What the platform does, who it is for, and how this guide is organised." },
    { slug: "getting-started/key-terms", title: "Key terms", summary: "Organisations, events, series, registrations, orders, tickets and the other words used throughout the app." },
    { slug: "getting-started/organiser-quick-start", title: "Run your first event", summary: "From a new account to a published event with guests checked in at the door." },
  ],
} as const satisfies HelpSectionEntry;
