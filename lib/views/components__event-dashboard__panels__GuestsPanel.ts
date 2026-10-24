import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { prisma } from "@/lib/db";
import { loadAttendees, loadEventInvites, loadRegistrationFields } from "@/lib/eventDashboard/data";
import { loadEventTeams, loadTeamMoveTargets } from "@/lib/eventDashboard/teams";
import { DEFAULT_CURRENCY } from "@/lib/payments/money";

export async function loadGuestsPanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  const { event, permissions, organisation } = ctx;
  const teamMode = event.registrationMode === "TEAM";
  const teamsAllowed = teamMode && permissions.canManageRegistrations;
  const [attendees, fields, invites, ticketTypes, teamsPage, moveTargets] = await Promise.all([
    permissions.canManageRegistrations ? loadAttendees(event.id, ctx.origin) : Promise.resolve({ attendees: [], truncated: false }),
    loadRegistrationFields(event.id),
    permissions.canManageInvitations ? loadEventInvites(event.id) : Promise.resolve([]),
    permissions.canManageRegistrations
      ? prisma.ticketType.findMany({ where: { eventId: event.id, archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, priceMinor: true } })
      : Promise.resolve([]),
    teamsAllowed ? loadEventTeams(ctx) : Promise.resolve(null),
    teamsAllowed ? loadTeamMoveTargets(ctx) : Promise.resolve([]),
  ]);
  const currency = event.currency ?? DEFAULT_CURRENCY;
  return {
    permissions, organisation, event, attendees, fields, invites, teamMode, teamsPage, moveTargets,
    ticketTypes: ticketTypes.map((type) => ({ id: type.id, name: type.name, priceMinor: Number(type.priceMinor), currency })),
  };
}

import { loadEventDashboard } from "@/lib/eventDashboard/context";
