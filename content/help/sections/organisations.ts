import type { HelpSectionEntry } from "../manifest";

export const organisations = {
  id: "organisations",
  title: "Organisations and people",
  description: "Set up the group that runs your events, decide who can do what, and connect your own email and chat.",
  access: "public",
  articles: [
    { slug: "organisations/create", title: "Creating an organisation", summary: "Start the workspace your events live in." },
    { slug: "organisations/roles", title: "Roles and permissions", summary: "What owners, admins, members and co-organisers can each do." },
    { slug: "organisations/members", title: "Inviting and managing members", summary: "Invite people, change roles and remove members." },
    { slug: "organisations/co-organisers", title: "Event co-organisers", summary: "Give someone outside your organisation exact permissions on one event." },
    { slug: "organisations/settings", title: "Organisation settings", summary: "Name, address, logo, public page, and deleting an organisation." },
    { slug: "organisations/email-sending", title: "Sending email from your organisation", summary: "Send your organisation's emails through your own mail server or under your name." },
    { slug: "organisations/chat-notifications", title: "Chat notifications", summary: "Post registrations, payments and other activity to your team's chat." },
    { slug: "organisations/member-ids", title: "Member IDs", summary: "Issue ID cards to your members, design them, and let anyone verify one." },
  ],
} as const satisfies HelpSectionEntry;
