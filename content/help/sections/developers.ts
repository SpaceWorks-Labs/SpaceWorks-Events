import type { HelpSectionEntry } from "../manifest";

export const developers = {
  id: "developers",
  title: "Connecting other tools",
  description: "For organisation owners and admins: the machine API and outgoing webhooks.",
  access: "org-admin",
  articles: [
    { slug: "developers/api", title: "The machine API", summary: "Read events and participant rosters from your own systems." },
    { slug: "developers/webhooks", title: "Webhooks", summary: "Get notified in other tools when guests register, pay, check in and more." },
  ],
} as const satisfies HelpSectionEntry;
