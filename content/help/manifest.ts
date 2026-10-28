/**
 * The in-app guide's table of contents (`/help`). Each article's body lives in
 * `content/help/<slug>.mdx`; titles, summaries and who may read it live in the
 * section files under `content/help/sections/`, so navigation, search and
 * metadata never have to parse MDX. The section order below is the reading
 * order of the guide.
 *
 * `access` gates whole sections: `public` is readable by anyone, `org-admin`
 * by owners and admins of any organisation, `super-admin` by the instance
 * super admin only (lib/help/access.ts). It is a reading convenience, never
 * an authorization boundary for the features described.
 */
import { gettingStarted } from "./sections/getting-started";
import { account } from "./sections/account";
import { attending } from "./sections/attending";
import { organisations } from "./sections/organisations";
import { events } from "./sections/events";
import { eventPage } from "./sections/event-page";
import { registration } from "./sections/registration";
import { payments } from "./sections/payments";
import { guests } from "./sections/guests";
import { volunteers } from "./sections/volunteers";
import { checkIn } from "./sections/check-in";
import { hackathons } from "./sections/hackathons";
import { finance } from "./sections/finance";
import { after } from "./sections/after";
import { developers } from "./sections/developers";
import { instance } from "./sections/instance";
import { installation } from "./sections/installation";
import { troubleshooting } from "./sections/troubleshooting";

export type HelpAccess = "public" | "org-admin" | "super-admin";

export type HelpArticleEntry = {
  /** Path under /help and under content/help, e.g. "events/publishing". */
  slug: string;
  title: string;
  /** One sentence shown under the title, in lists and in search results. */
  summary: string;
};

export type HelpSectionEntry = {
  id: string;
  title: string;
  description: string;
  access: HelpAccess;
  articles: readonly HelpArticleEntry[];
};

export const helpSections = [
  gettingStarted,
  account,
  attending,
  organisations,
  events,
  eventPage,
  registration,
  payments,
  guests,
  volunteers,
  checkIn,
  hackathons,
  finance,
  after,
  developers,
  instance,
  installation,
  troubleshooting,
] as const satisfies readonly HelpSectionEntry[];

export type HelpArticleSlug = (typeof helpSections)[number]["articles"][number]["slug"];
