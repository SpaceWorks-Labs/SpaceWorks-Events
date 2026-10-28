import type { HelpSectionEntry } from "../manifest";

export const applications = {
  id: "applications",
  title: "Applications and shortlisting",
  description: "Make registration an application: review it in stages, shortlist, and offer places, on any event, free or paid.",
  access: "public",
  articles: [
    { slug: "applications/overview", title: "Taking applications", summary: "When to use applications, turning them on, and how free and paid places work." },
    { slug: "applications/stages-and-reviewers", title: "Stages and reviewers", summary: "Add review stages, choose each stage's panel and assign reviewers fairly." },
    { slug: "applications/decisions-and-offers", title: "Decisions, offers and the waitlist", summary: "Draft and release decisions, make offers, and fill places from the waitlist." },
    { slug: "applications/reviewing", title: "Reviewing applications", summary: "For reviewers: score the applications assigned to you." },
  ],
} as const satisfies HelpSectionEntry;
