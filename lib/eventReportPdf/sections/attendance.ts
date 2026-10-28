import "server-only";

import { arrivalWindows, busiestDay, signupTimeline } from "@/components/event-dashboard/analytics/metrics";
import type { EventReportMetrics } from "@/lib/eventReport";
import { formatDate, formatTime, formatTimeZoneName } from "@/lib/format/datetime";
import type { ReportLayout } from "../layout";
import { C, CONTENT_WIDTH, percentLabel, plural } from "../style";

/** Who signed up, and how many got a place. */
export function drawRegistrations(L: ReportLayout, metrics: EventReportMetrics, tz: string) {
  const { A, section, subheading, barRows, facts, columnChart, chips } = L;
  // ---------- Registrations ----------

  const timeline = metrics.signupDates?.length ? signupTimeline(metrics.signupDates, metrics.endDateTime, tz) : null;
  section("Who signed up", "Registrations", "How people signed up, how many got a place and how many came.");
  barRows([
    { label: "Signed up", value: metrics.total, whole: metrics.total, color: C.ink, note: metrics.total.toLocaleString("en-GB") },
    { label: "Going", value: metrics.confirmed, whole: metrics.total, color: A.solid },
    { label: "Checked in", value: metrics.checkedIn, whole: metrics.total, color: C.teal },
    ...(metrics.feedbackResponseCount != null ? [{ label: "Shared feedback", value: metrics.feedbackResponseCount, whole: metrics.total, color: C.orange }] : []),
  ]);
  chips([
    { label: `Going ${metrics.confirmed}`, bg: C.successBg, fg: C.successFg },
    { label: `Waitlist ${metrics.waitlisted}`, bg: C.warningBg, fg: C.warningFg },
    { label: `To approve ${metrics.pendingApproval}`, bg: C.muted, fg: C.textSecondary },
    { label: `Declined ${metrics.rejected}`, bg: C.dangerBg, fg: C.dangerFg },
  ]);

  // TEAM events count capacity in units: confirmed teams plus confirmed solo registrants.
  const capacityFact = () => {
    if (metrics.capacity == null) return "No limit";
    if (!metrics.teams) return `${metrics.confirmed.toLocaleString("en-GB")} of ${plural(metrics.capacity, "place")} filled (${percentLabel(metrics.confirmed, metrics.capacity)})`;
    const units = metrics.teams.confirmedTeams + metrics.teams.confirmedSoloRegistrants;
    return `${units.toLocaleString("en-GB")} of ${plural(metrics.capacity, "place")} filled by teams and solo registrants (${percentLabel(units, metrics.capacity)})`;
  };
  const registrationFacts: Array<[string, string]> = [
    ["Capacity", capacityFact()],
  ];
  if (metrics.registrationClosesAt) registrationFacts.push(["Registration closed", `${formatDate(metrics.registrationClosesAt, tz)}, ${formatTime(metrics.registrationClosesAt, tz)}`]);
  if (metrics.signupDates?.length) {
    const sorted = [...metrics.signupDates].sort((a, b) => a.getTime() - b.getTime());
    registrationFacts.push(["First sign-up", formatDate(sorted[0]!, tz)]);
    const busiest = busiestDay(metrics.signupDates, tz);
    if (busiest) registrationFacts.push(["Busiest day", `${busiest.day}, ${plural(busiest.count, "sign-up")}`]);
  }
  if (metrics.teams) {
    // Counts only: team names, members and "looking for a team" profiles never appear in the report.
    const { teams, confirmedTeams, soloRegistrants, averageTeamSize } = metrics.teams;
    registrationFacts.push(["Teams", teams ? `${plural(teams, "team")}, ${confirmedTeams.toLocaleString("en-GB")} with a place` : "No teams"]);
    if (teams) registrationFacts.push(["Average team size", `${averageTeamSize.toLocaleString("en-GB")} people`]);
    registrationFacts.push(["Solo registrants", soloRegistrants ? plural(soloRegistrants, "person", "people") : "None"]);
  }
  registrationFacts.push(["Invitations", metrics.invitationCount ? plural(metrics.invitationCount, "person", "people") + " invited by email" : "None sent"]);
  if (metrics.waitlist && metrics.waitlist.joined > 0) {
    registrationFacts.push(["Waitlist", `${plural(metrics.waitlist.joined, "person", "people")} joined; ${metrics.waitlist.promoted.toLocaleString("en-GB")} got a place (${percentLabel(metrics.waitlist.promoted, metrics.waitlist.joined)})`]);
  }
  if (metrics.shortLinkVisits != null) registrationFacts.push(["Short link", metrics.shortLinkVisits ? plural(metrics.shortLinkVisits, "visit") : "Not opened yet"]);
  facts(registrationFacts);

  if (timeline && timeline.columns.length > 1) {
    subheading("Sign-ups over time", timeline.intervalDays === 1 ? "Sign-ups per day." : `Sign-ups per ${timeline.intervalDays} days.`, 210);
    // Grouped columns are labelled by their first day; the note above says how many days each holds.
    columnChart(timeline.columns.map((column) => ({ ...column, label: column.label.split(" – ")[0]! })), A.solid, `${plural(timeline.total, "sign-up")} over ${plural(timeline.spanDays, "day")}, up to the end of the event.`);
  }
}

/** Who arrived, and when. */
export function drawAtTheDoor(L: ReportLayout, metrics: EventReportMetrics, tz: string) {
  const { T, paragraph, section, subheading, barRows, facts, columnChart } = L;
  // ---------- At the door ----------

  section("Check-in", "At the door", "Who arrived, and when.");
  if (metrics.checkedIn === 0) {
    paragraph("Nobody was checked in with Space Works Events for this event. If you checked people in another way, this section stays empty.", T.body(), CONTENT_WIDTH);
  } else {
    barRows([
      { label: "Checked in", value: metrics.checkedIn, whole: metrics.confirmed, color: C.teal },
      { label: "Did not come", value: metrics.noShows, whole: metrics.confirmed, color: C.textMuted },
    ]);
    const arrivals = arrivalWindows(metrics.checkInTimes ?? [], tz);
    const doorFacts: Array<[string, string]> = [];
    if (arrivals) {
      doorFacts.push(["First check-in", `${formatTime(arrivals.first, tz)}, ${formatDate(arrivals.first, tz)}`]);
      doorFacts.push(["Busiest time", `${arrivals.peak.label}, ${plural(arrivals.peak.count, "arrival")}`]);
    }
    const sources = metrics.checkInSources;
    if (sources) {
      const parts = [
        sources.organiser ? `${sources.organiser} on organiser devices` : "",
        sources.offline ? `${sources.offline} offline, then synced` : "",
        sources.station ? `${sources.station} at the door station` : "",
      ].filter(Boolean);
      if (parts.length) doorFacts.push(["Checked in by", parts.join(", ")]);
    }
    facts(doorFacts);
    if (arrivals && arrivals.columns.length > 1) {
      subheading("Arrivals", `Check-ins per ${arrivals.minutes < 60 ? `${arrivals.minutes} minutes` : arrivals.minutes === 60 ? "hour" : `${arrivals.minutes / 60} hours`}, in ${formatTimeZoneName(metrics.startDateTime, tz)}.`, 210);
      columnChart(arrivals.columns, C.teal,`Times show when each guest was checked in, from the first arrival to the last.`);
    }
  }
}
