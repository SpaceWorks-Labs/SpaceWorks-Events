import type { HelpSectionEntry } from "../manifest";

export const attending = {
  id: "attending",
  title: "Going to events",
  description: "For guests: finding events, registering and paying, your ticket, teams, projects, IDs and certificates.",
  access: "public",
  articles: [
    { slug: "attending/finding-events", title: "Finding events", summary: "Discover, search, organisation pages and short links." },
    { slug: "attending/registering", title: "Registering for an event", summary: "Sign up as a guest or with an account, and what happens with approvals and waitlists." },
    { slug: "attending/your-application", title: "Your application", summary: "Follow your application, answer an offer, and accept (and pay for) your place." },
    { slug: "attending/paying-for-tickets", title: "Paying for a ticket", summary: "Choose tickets and extras, use a promo or access code, and pay the organiser securely." },
    { slug: "attending/orders-and-receipts", title: "Your order and receipt", summary: "Open your order page, download your receipt, and find your tickets after paying." },
    { slug: "attending/asking-for-a-refund", title: "Asking for a refund", summary: "Request your money back, and what happens when an event is cancelled." },
    { slug: "attending/your-ticket", title: "Your ticket", summary: "Open, download and use your QR ticket, add it to your calendar, or cancel." },
    { slug: "attending/joining-the-crew", title: "Joining an event's crew", summary: "Sign up with a crew link, get your crew ticket, and what's different for crew." },
    { slug: "attending/still-coming", title: "Answering \"Are you still coming?\"", summary: "Tell the organisers whether you can still make it, and what a No does to your place." },
    { slug: "attending/teams", title: "Registering as a team", summary: "Create or join a team, register solo, find teammates, and manage your team page." },
    { slug: "attending/submitting-a-project", title: "Submitting a hackathon project", summary: "Draft, submit, edit and withdraw your team's or your own project." },
    { slug: "attending/claiming-expenses", title: "Claiming expenses", summary: "Ask the organiser to pay back travel or other costs from your ticket page." },
    { slug: "attending/member-id", title: "Your member ID", summary: "Open, download and show the ID card an organisation issues you." },
    { slug: "attending/feedback-and-certificates", title: "Feedback and certificates", summary: "Answer an event's feedback form and download your certificate." },
  ],
} as const satisfies HelpSectionEntry;
