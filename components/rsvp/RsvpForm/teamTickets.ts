import type { TeamRegistrationConfig } from "@/components/rsvp/TeamRegistrationFields";
import type { PublicTicketType } from "@/lib/payments/tickets";

/**
 * Tickets on a TEAM event (docs/TEAMS.md): every order seats one person, so
 * each ticket is bought one at a time. When the leader pays once for the
 * whole team (PER_TEAM), joining is free and the form shows no tickets.
 */
export function teamTicketing(team: TeamRegistrationConfig | null | undefined, mode: "create" | "join" | "solo", tickets: PublicTicketType[]) {
  if (!team) return { tickets, showTickets: true, note: null };
  const perTeam = team.ticketMode === "PER_TEAM";
  const joining = Boolean(team.joinTeam) || mode === "join";
  const single = tickets.map((ticket) => ({ ...ticket, minPerOrder: 1, maxPerOrder: 1 }));
  if (perTeam && joining) return { tickets: single, showTickets: false, note: "Joining is free: your team leader's ticket covers the whole team." };
  if (perTeam && mode === "create") return { tickets: single, showTickets: true, note: "One ticket covers your whole team. Members join free with your team link once it's paid." };
  return { tickets: single, showTickets: true, note: joining || mode === "create" ? "Everyone in a team buys their own ticket." : null };
}
