import type { HelpSectionEntry } from "../manifest";

export const volunteers = {
  id: "volunteers",
  title: "Volunteers and shifts",
  description: "Run volunteer shifts for your crew, check volunteers in and out, verify their hours and thank them with a certificate.",
  access: "public",
  articles: [
    { slug: "volunteers/shifts-and-hours", title: "Volunteer shifts and hours", summary: "Add shifts, approve sign-ups, run the attendance desk and verify hours." },
    { slug: "volunteers/my-shifts", title: "Signing up for shifts", summary: "For crew: sign up for shifts, check in and out, and see your hours from your crew ticket." },
    { slug: "volunteers/contributor-certificates", title: "Contributor certificates", summary: "Design, issue and revoke certificates that show each person's role and verified hours." },
  ],
} as const satisfies HelpSectionEntry;
