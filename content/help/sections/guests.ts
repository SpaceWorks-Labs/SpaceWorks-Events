import type { HelpSectionEntry } from "../manifest";

export const guests = {
  id: "guests",
  title: "Guests and emails",
  description: "Manage your guest list, teams and exports, and email the people coming.",
  access: "public",
  articles: [
    { slug: "guests/guest-list", title: "The guest list", summary: "Statuses, approving and declining, adding guests by hand, and undo." },
    { slug: "guests/managing-teams", title: "Managing teams", summary: "Approve whole teams, move members and tidy up teams." },
    { slug: "guests/saved-views", title: "Filters and saved views", summary: "Filter long lists, save the views you use and share them with your team." },
    { slug: "guests/exports", title: "Exporting guest data", summary: "Download guests, teams and email addresses as CSV." },
    { slug: "guests/event-crew", title: "Event crew", summary: "Give your volunteers and helpers free crew tickets, a sign-up link, food counts and a Crew section." },
    { slug: "guests/attendance-confirmation", title: "Attendance confirmation", summary: "Ask confirmed guests \"Are you still coming?\", remind them, and free places when they say No." },
    { slug: "guests/emailing-guests", title: "Emailing your guests", summary: "Templates, placeholders, designs, drafts, tests and sending." },
    { slug: "guests/automatic-emails", title: "Automatic emails", summary: "The emails the app sends for you, and when." },
  ],
} as const satisfies HelpSectionEntry;
