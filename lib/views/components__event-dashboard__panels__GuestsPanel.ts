import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { prisma } from "@/lib/db";
import { loadRegistrationFields } from "@/lib/eventDashboard/data";
import { loadAttendeesFirstPage } from "@/lib/eventDashboard/attendees";
import { loadEventInvitesFirstPage } from "@/lib/eventDashboard/invites";
import { loadEventTeams } from "@/lib/eventDashboard/teams";
import { loadSavedViewsForDashboard } from "@/lib/eventDashboard/savedViews";
import { DEFAULT_CURRENCY } from "@/lib/payments/money";

export async function loadGuestsPanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  const { event, permissions, organisation } = ctx;
  const teamMode = event.registrationMode === "TEAM";
  const teamsAllowed = teamMode && permissions.canManageRegistrations;
  // Every list here is paged on the server; only first pages load with the panel.
  const [attendees, fields, invites, ticketTypes, teamsPage, savedViews] = await Promise.all([
    permissions.canManageRegistrations ? loadAttendeesFirstPage(ctx) : Promise.resolve(null),
    loadRegistrationFields(event.id),
    permissions.canManageInvitations ? loadEventInvitesFirstPage(event.id, organisation.id) : Promise.resolve(null),
    permissions.canManageRegistrations
      ? prisma.ticketType.findMany({ where: { eventId: event.id, archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, priceMinor: true } })
      : Promise.resolve([]),
    teamsAllowed ? loadEventTeams(ctx) : Promise.resolve(null),
    loadSavedViewsForDashboard(ctx),
  ]);
  const currency = event.currency ?? DEFAULT_CURRENCY;
  return {
    permissions, organisation, event, attendees, fields, invites, teamMode, teamsPage, savedViews,
    ticketTypes: ticketTypes.map((type) => ({ id: type.id, name: type.name, priceMinor: Number(type.priceMinor), currency })),
  };
}

import { loadEventDashboard } from "@/lib/eventDashboard/context";
