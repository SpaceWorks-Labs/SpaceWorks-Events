import type { HelpSectionEntry } from "../manifest";

export const troubleshooting = {
  id: "troubleshooting",
  title: "Troubleshooting",
  description: "Answers to common questions and fixes for common problems.",
  access: "public",
  articles: [
    { slug: "troubleshooting/faq", title: "Frequently asked questions", summary: "Quick answers for guests and organisers." },
    { slug: "troubleshooting/common-problems", title: "Common problems", summary: "Emails not arriving, payments, tickets that won't scan, pages that won't load, and more." },
  ],
} as const satisfies HelpSectionEntry;
