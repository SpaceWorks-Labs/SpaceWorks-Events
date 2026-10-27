import type { HelpSectionEntry } from "../manifest";

export const installation = {
  id: "installation",
  title: "Installing and maintaining",
  description: "For the person who runs this server: installing on a VPS, updates, backups and recovery.",
  access: "super-admin",
  articles: [
    { slug: "installation/vps-install", title: "Installing on a VPS", summary: "The one-line installer, the questions it asks, and what it sets up." },
    { slug: "installation/updates-backups-status", title: "Updates, backups and status", summary: "Keep the server up to date, check the nightly backups, and check its health." },
    { slug: "installation/recovery-and-support", title: "Recovery and support bundles", summary: "Get back into the super admin account, change settings, and collect a support bundle." },
  ],
} as const satisfies HelpSectionEntry;
