import { describe, expect, it } from "vitest";
import { teamTicketing } from "@/components/rsvp/RsvpForm/teamTickets";
import type { PublicTicketType } from "@/lib/payments/tickets";

const ticket = { id: "t1", name: "Entry", minPerOrder: 2, maxPerOrder: 5 } as PublicTicketType;
const team = (ticketMode: "PER_MEMBER" | "PER_TEAM", joinTeam = false) => ({
  soloPolicy: "SOLO_ALLOWED" as const, teamMinSize: null, teamMaxSize: 4, ticketMode,
  ...(joinTeam ? { joinTeam: { joinToken: "x".repeat(43), name: "Rockets", size: 1, maxSize: 4 } } : {}),
});

describe("team ticketing on the registration form (docs/TEAMS.md)", () => {
  it("leaves individual events alone", () => {
    expect(teamTicketing(null, "create", [ticket])).toEqual({ tickets: [ticket], showTickets: true, note: null });
  });

  it("sells one ticket per person on team events", () => {
    const result = teamTicketing(team("PER_MEMBER"), "create", [ticket]);
    expect(result.tickets).toEqual([{ ...ticket, minPerOrder: 1, maxPerOrder: 1 }]);
    expect(result).toMatchObject({ showTickets: true, note: "Everyone in a team buys their own ticket." });
    expect(teamTicketing(team("PER_MEMBER"), "solo", [ticket]).note).toBeNull();
  });

  it("hides tickets when a PER_TEAM member joins, and explains the leader's ticket", () => {
    expect(teamTicketing(team("PER_TEAM", true), "join", [ticket])).toMatchObject({ showTickets: false, note: expect.stringContaining("free") });
    expect(teamTicketing(team("PER_TEAM"), "create", [ticket])).toMatchObject({ showTickets: true, note: expect.stringContaining("whole team") });
  });
});
