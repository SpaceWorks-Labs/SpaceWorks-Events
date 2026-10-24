import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadRegistrationFields, loadRsvpStatusCounts } from "@/lib/eventDashboard/data";
import { loadBroadcastCount, loadEventTeam, loadPendingRequests, loadRecentSignupDates } from "@/lib/eventDashboard/overview";
import { loadPendingUnits } from "@/lib/eventDashboard/teams";
import { eventPhase, readinessHeading, readinessItems } from "@/components/event-dashboard/overview/readiness";
export async function loadOverviewPanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);

  const { event, permissions, organisation, now } = ctx;
  const guests = permissions.canManageRegistrations;
  // TEAM events count pending requests in units: each team once, plus each solo registrant.
  const teamMode = event.registrationMode === "TEAM";

  const [counts, fields, emailsSent, signupDates, requests, team, pendingUnits] = await Promise.all([
    guests ? loadRsvpStatusCounts(event.id) : null,
    guests ? loadRegistrationFields(event.id) : null,
    guests ? loadBroadcastCount(event.id) : 0,
    guests ? loadRecentSignupDates(event.id, now) : null,
    guests ? (teamMode ? loadPendingUnits(event.id).then((pending) => pending.units) : loadPendingRequests(event.id)) : null,
    permissions.canManageCollaborators ? loadEventTeam(organisation.id, event.id) : null,
    guests && teamMode ? loadPendingUnits(event.id) : null,
  ]);
  const pendingTotal = pendingUnits?.total ?? counts?.pendingApproval ?? 0;

  const phase = eventPhase(event.startDateTime, event.endDateTime, now);
  const approvalRequired = event.privacyType === "APPROVAL_REQUIRED";
  const items = readinessItems({
    published: event.status === "PUBLISHED",
    hasCoverImage: Boolean(event.coverImageUrl),
    hasAccent: Boolean(event.page?.accentColor),
    isOnline: event.isOnline,
    sessionCount: event.sessions.length,
    registrationFieldCount: fields?.length ?? 0,
    // Only whether a PIN exists; the hash itself never leaves the server.
    stationPinSet: event.stationEnabled,
    approvalRequired,
    pendingApprovals: pendingTotal,
    teamMode,
    pendingTeams: pendingUnits?.teams ?? 0,
    emailsSent,
    permissions,
  });
  const heading = readinessHeading({ items, start: event.startDateTime, end: event.endDateTime, now, timeZone: event.timezone });

  const path = `/${organisation.slug}/${event.slug}`;
  const showWaiting = Boolean(requests && counts && (pendingTotal > 0 || approvalRequired));
  const hasMain = guests;


  return { event, permissions, organisation, now, counts, fields, emailsSent, signupDates, requests, team, phase, approvalRequired, items, heading, path, showWaiting, hasMain, pendingTotal };
}
import { loadEventDashboard } from "@/lib/eventDashboard/context";
