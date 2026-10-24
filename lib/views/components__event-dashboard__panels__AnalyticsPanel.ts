import { loadRevenue } from "@/lib/payments/revenue";
import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadCapacityUsed, loadRsvpStatusCounts } from "@/lib/eventDashboard/data";
import { teamCapacityLabel } from "@/lib/teamCapacityDisplay";
import { loadAllSignupDates, loadFeedbackCount } from "@/lib/eventDashboard/overview";
import { type MixPart } from "@/components/event-dashboard/analytics/AnalyticsSections";
import { arrivalWindows, busiestDay, capacityStatus, clickSeries, funnelSentence, funnelSteps, localDateKey, percentOf, signupsLastWeek, signupTimeline } from "@/components/event-dashboard/analytics/metrics";
import { prisma } from "@/lib/db";
import { countCheckInSources, summariseQuestions } from "@/lib/eventReport";
export async function loadAnalyticsPanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);

  const { event, permissions, now } = ctx;
  if (!permissions.canViewAnalytics) notFound();

  // TEAM events fill capacity in units (teams plus solo registrants), not people.
  const teamMode = event.registrationMode === "TEAM";
  const [counts, feedback, signupDates, units] = await Promise.all([
    loadRsvpStatusCounts(event.id),
    loadFeedbackCount(event.id),
    loadAllSignupDates(event.id),
    teamMode ? loadCapacityUsed(event.id, event.registrationMode) : null,
  ]);
  const ended = event.endDateTime < now;
  const steps = funnelSteps({ responded: counts.total, going: counts.confirmed, checkedIn: counts.checkedIn, feedback, ended });
  const checkedIn = steps.find((step) => step.key === "checkedIn")!.value;
  const summary = funnelSentence({ responded: counts.total, going: counts.confirmed, checkedIn, ended });

  const parts: MixPart[] = [
    { key: "going", label: "Going", hint: "Have a place and a ticket", value: counts.confirmed, tone: "bg-accent-text" },
    { key: "waitlist", label: "Waitlist", hint: "Signed up after the event was full", value: counts.waitlisted, tone: "bg-info-solid" },
    { key: "pending", label: "Waiting for approval", hint: "Need a decision from an organiser", value: counts.pendingApproval, tone: "bg-highlight" },
    { key: "declined", label: "Declined", hint: "Declined by an organiser", value: counts.rejected, tone: "bg-danger-solid" },
  ];

  const capacity = capacityStatus(units ?? counts.confirmed, event.capacity);
  const capacityDetail = !capacity
    ? "No capacity limit set"
    : units != null
      ? `${teamCapacityLabel(units, event.capacity, event.soloPolicy)}${capacity.full ? " · full" : ""}`
      : capacity.full
        ? `Full · all ${event.capacity} places taken`
        : `${capacity.left} of ${event.capacity} places left`;
  const turnout = checkedIn != null ? percentOf(checkedIn, counts.confirmed) : null;
  const keyNumbers = [
    {
      key: "going",
      label: "Going",
      value: String(counts.confirmed),
      tone: "bg-accent-text",
      bar: capacity ? capacity.percent / 100 : undefined,
      detail: capacityDetail,
    },
    {
      key: "waitlist",
      label: "Waitlist",
      value: String(counts.waitlisted),
      tone: "bg-info-solid",
      detail: counts.waitlisted ? "Waiting for a place" : "Nobody waiting",
    },
    {
      key: "pending",
      label: "Waiting for approval",
      value: String(counts.pendingApproval),
      tone: "bg-highlight",
      detail: counts.pendingApproval ? "Need your decision" : "Nothing to review",
      action: counts.pendingApproval && !ended ? { tab: "guests", label: "Review" } : undefined,
    },
    {
      key: "turnout",
      label: "Turnout",
      value: turnout != null && checkedIn! <= counts.confirmed ? `${turnout}%` : checkedIn != null ? String(checkedIn) : "—",
      tone: "bg-success-solid",
      bar: turnout != null ? Math.min(100, turnout) / 100 : undefined,
      detail:
        checkedIn == null
          ? "Shows once check-in starts"
          : turnout != null && checkedIn <= counts.confirmed
            ? `${checkedIn} of ${counts.confirmed} going checked in`
            : `${checkedIn} checked in`,
    },
  ];

  const until = ended ? event.endDateTime : now;
  const timeline = signupTimeline(signupDates, until, event.timezone);
  const busiest = busiestDay(
    signupDates.filter((date) => date <= until),
    event.timezone,
  );
  const lastWeek = ended ? null : signupsLastWeek(signupDates, until, event.timezone);


  // Door, questions, waitlist and short link: counts and times only, never who.
  const [confirmed, form, waitlistJoined, waitlistPromoted, shortLink] = await Promise.all([
    prisma.rSVP.findMany({
      where: { eventId: event.id, status: "CONFIRMED" },
      select: {
        id: true,
        checkedInAt: true,
        answers: { select: { fieldId: true, valueText: true, valueBool: true } },
        checkInEvents: { where: { action: "CHECKED_IN" }, orderBy: { occurredAt: "desc" }, take: 1, select: { source: true } },
      },
    }),
    prisma.eventRegistrationForm.findUnique({ where: { eventId: event.id }, select: { fields: { orderBy: { sortOrder: "asc" }, select: { id: true, label: true, type: true, options: true } } } }),
    prisma.rSVP.count({ where: { eventId: event.id, waitlistedAt: { not: null } } }),
    prisma.rSVP.count({ where: { eventId: event.id, promotedAt: { not: null } } }),
    prisma.event.findUnique({ where: { id: event.id }, select: { shortCode: true, shortLinkClickDays: { select: { day: true, count: true } } } }),
  ]);
  const arrivedRsvps = confirmed.filter((rsvp) => rsvp.checkedInAt);
  const arrivals = arrivalWindows(arrivedRsvps.map((rsvp) => rsvp.checkedInAt!), event.timezone);
  const sources = arrivedRsvps.length ? countCheckInSources(arrivedRsvps.map((rsvp) => rsvp.checkInEvents[0]?.source ?? null)) : null;
  const questions = summariseQuestions(form?.fields ?? [], confirmed.flatMap((rsvp) => rsvp.answers.map((answer) => ({ ...answer, respondentId: rsvp.id }))));
  const waitlist = waitlistJoined > 0 ? { joined: waitlistJoined, promoted: waitlistPromoted, waiting: counts.waitlisted, percent: percentOf(waitlistPromoted, waitlistJoined) } : null;
  const clicks = shortLink?.shortCode
    ? { code: shortLink.shortCode, series: clickSeries(shortLink.shortLinkClickDays.map((row) => ({ day: row.day.toISOString().slice(0, 10), count: row.count })), localDateKey(now, event.timezone)) }
    : null;

  const revenue = await loadRevenue({ eventId: event.id }, event.timezone, now);
  return { event, permissions, now, counts, feedback, signupDates, ended, steps, checkedIn, summary, parts, capacity, turnout, keyNumbers, timeline, busiest, lastWeek, arrivals, sources, questions, waitlist, clicks, revenue };
}

import { notFound } from "next/navigation";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
