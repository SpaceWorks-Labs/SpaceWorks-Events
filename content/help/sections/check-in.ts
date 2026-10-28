import type { HelpSectionEntry } from "../manifest";

export const checkIn = {
  id: "check-in",
  title: "Tickets and check-in",
  description: "Design your tickets, get guests through the door quickly, online or off, and print badges.",
  access: "public",
  articles: [
    { slug: "check-in/ticket-designer", title: "The ticket designer", summary: "Design the tickets guests download as an image or PDF." },
    { slug: "check-in/check-in-desk", title: "The check-in desk", summary: "Scan tickets, type codes or search by name, and undo mistakes." },
    { slug: "check-in/offline", title: "Checking in offline", summary: "Keep the door moving when the Wi-Fi drops." },
    { slug: "check-in/door-station", title: "The door station", summary: "A PIN-locked check-in page for volunteers without an account." },
    { slug: "check-in/check-in-lists", title: "Custom check-in lists", summary: "Track swag, meals and workshops alongside entry." },
    { slug: "check-in/badges", title: "ID cards and badges", summary: "Design name badges and print them one at a time or in sheets." },
  ],
} as const satisfies HelpSectionEntry;
