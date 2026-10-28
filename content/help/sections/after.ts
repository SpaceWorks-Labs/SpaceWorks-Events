import type { HelpSectionEntry } from "../manifest";

export const after = {
  id: "after",
  title: "Feedback and reporting",
  description: "Hear from your guests, send certificates and see how the event went.",
  access: "public",
  articles: [
    { slug: "after/feedback", title: "Feedback forms", summary: "Collect anonymous or verified feedback after your event." },
    { slug: "after/certificates", title: "The certificate designer", summary: "Design certificates guests download after giving feedback." },
    { slug: "after/analytics", title: "Analytics", summary: "Your registration funnel and attendance at a glance." },
    { slug: "after/event-report", title: "The post-event report", summary: "A PDF summary of your event for sponsors, funders and your team." },
  ],
} as const satisfies HelpSectionEntry;
