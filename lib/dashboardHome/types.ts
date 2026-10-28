import "server-only";

import type { FillStatus } from "@/lib/dashboardHomeMetrics";

export type HomeEventRow = {
  key: string;
  /** Management link; null when the person cannot manage this organisation's events. */
  href: string | null;
  title: string;
  organisationName: string;
  dateBlock: { start: Date; timezone: string };
  meta: string;
  accent: string;
  isSeries: boolean;
  isDraft: boolean;
  status: FillStatus;
  fill: { filled: number; total: number } | null;
};

export type HomeActivity = {
  key: string;
  kind: "registered" | "waitlisted" | "pending" | "checkedIn" | "feedback";
  who: string;
  eventTitle: string;
  at: Date;
  timezone: string;
};

export type HomeStat = { label: string; value: number | string; hint: string; levels: number[]; tone: "ink" | "marigold" | "success" | "amber" };

export type HomeOrganisation = { id: string; slug: string; name: string; logoUrl: string | null; role: string; upcoming: number; members: number };

export type HomeLiveEvent = {
  id: string;
  title: string;
  /** Management link; null for members who cannot manage events. */
  href: string | null;
  checkInHref: string | null;
  scheduleHref: string | null;
  timezone: string;
  location: string;
  startDateTime: Date;
  endDateTime: Date;
  started: boolean;
  confirmed: number;
  checkedIn: number;
  arrivals: { label: Date; count: number }[];
  door: { key: string; who: string; at: Date }[];
  onStage: { now: { title: string; start: Date; end: Date } | null; next: { title: string; start: Date } | null };
};

export type DashboardHome = {
  summary: string;
  mood: "happy" | "cheering" | "sleepy";
  organisations: HomeOrganisation[];
  adminOrganisations: { slug: string; name: string }[];
  needsYou: { pendingApprovals: number; approvalsHref: string | null; drafts: number; draftHref: string | null } | null;
  next: (HomeEventRow & { location: string; startDateTime: Date; timezone: string; confirmed: number; placesUsed: number; crew: number; capacity: number | null; capacityUnits: { used: number; noun: string } | null; signupsLastDay: number; checkInHref: string | null; recentNames: string[]; publicPath: string | null }) | null;
  stats: HomeStat[];
  upcoming: HomeEventRow[];
  drafts: HomeEventRow[];
  past: HomeEventRow[];
  counts: { upcoming: number; drafts: number };
  activity: HomeActivity[];
  live: HomeLiveEvent | null;
  setup: { hasOrganisation: boolean; hasLogo: boolean; hasEvent: boolean; hasPublished: boolean; firstAdminSlug: string | null } | null;
};
