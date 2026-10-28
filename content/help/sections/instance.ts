import type { HelpSectionEntry } from "../manifest";

export const instance = {
  id: "instance",
  title: "Instance administration",
  description: "For the person who runs this server: the super admin area.",
  access: "super-admin",
  articles: [
    { slug: "instance/super-admin-access", title: "The super admin area", summary: "Who can open it, how its password is set, and how sign-in is protected." },
    { slug: "instance/insights", title: "Overview and insights", summary: "Growth, activity, storage and support views across the instance." },
    { slug: "instance/settings", title: "Instance settings", summary: "Sign-ups, email delivery, Google sign-in, paid events, alerts and backup posture." },
    { slug: "instance/email-delivery", title: "Email delivery", summary: "How the outbox sends email, and what to do when it fails." },
    { slug: "instance/security-and-audit", title: "Security and the audit log", summary: "Sign-in protections, API clients and the searchable record of important actions." },
  ],
} as const satisfies HelpSectionEntry;
