import type { HelpSectionEntry } from "../manifest";

export const registration = {
  id: "registration",
  title: "Registration",
  description: "Decide who can sign up, what you ask them, and how places are given out.",
  access: "public",
  articles: [
    { slug: "registration/form", title: "The registration form", summary: "Question types, settings, and questions that only show when needed." },
    { slug: "registration/capacity-and-waitlist", title: "Capacity, waitlists and approvals", summary: "Limit places, run a waitlist, approve each sign-up, and close registration." },
    { slug: "registration/invitations", title: "Invite-only events", summary: "Send invitations and keep an event to the people you choose." },
    { slug: "registration/team-registration", title: "Setting up team registration", summary: "Register people in teams for hackathons, jams and competitions." },
  ],
} as const satisfies HelpSectionEntry;
