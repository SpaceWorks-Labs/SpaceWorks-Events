import { RegistrationMode, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { countConfirmedUnits } from "@/lib/teamUnits";
import { countConfirmedForEvent } from "@/lib/rsvpCapacity";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { addCrewMemberAsOrganiser, listCrewForOrganiser, listPublicCrew, moveCrewMember, removeCrewMember, updateCrewMemberAsOrganiser } from "@/lib/core/crew";
import { loadRsvpStatusCounts } from "@/lib/eventDashboard/data";
import { eventSelect, loadRsvpCounts } from "@/lib/dashboardHome/rows";
import { loadNextUp } from "@/lib/dashboardHome/eventCards";
import { addCrew, capacityCount, createCrewEvent, crew, crewEmail, ctxFor, register, setUpCrewOrgs, tearDownCrewOrgs } from "./helpers/crew";

/* Event crew (docs/CREW.md): crew tickets, capacity, conversion and the crew row itself. */

const crewTickets = (rsvpId: string) => prisma.outboxMessage.count({ where: { kind: "crew-ticket", payload: { path: ["checkInToken"], equals: rsvpId } } });

describe.sequential("event crew", () => {
  beforeAll(() => setUpCrewOrgs("core"));
  afterAll(async () => {
    await flushWebhookEmits();
    await tearDownCrewOrgs();
  });

  it("issues a free confirmed crew ticket with a crew email and keeps crew out of capacity", async () => {
    const event = await createCrewEvent({ capacity: 1 });
    const first = await addCrew(event);
    const second = await addCrew(event);
    for (const member of [first, second]) {
      expect(member.rsvp).toMatchObject({ eventId: event.id, status: RsvpStatus.CONFIRMED, isCrew: true, teamId: null, orderId: null, ticketTypeId: null, guestEmail: member.email });
      expect(member).toMatchObject({ showOnPage: true, joinedViaLink: false });
      await expect(crewTickets(member.rsvp.checkInToken)).resolves.toBe(1);
    }
    expect(second.sortOrder).toBeGreaterThan(first.sortOrder);
    await expect(countConfirmedForEvent(event.id)).resolves.toBe(0);
    await expect(capacityCount(event)).resolves.toBe(0);

    const attendee = await register(event, "attendee");
    const late = await register(event, "late");
    expect(attendee.rsvp.status).toBe(RsvpStatus.CONFIRMED);
    expect(late.rsvp.status).toBe(RsvpStatus.WAITLISTED);
    await expect(capacityCount(event)).resolves.toBe(1);
    // Crew still count in the headcount of people going.
    await expect(prisma.rSVP.count({ where: { eventId: event.id, status: RsvpStatus.CONFIRMED } })).resolves.toBe(3);

    const listed = await listCrewForOrganiser(ctxFor(event));
    expect(listed.members.map((member) => member.id)).toEqual([first.id, second.id]);
    expect(listed.food).toEqual([{ label: "Vegan", count: 2 }]);
  });

  it("names crew beside the places in every dashboard count, never inside them", async () => {
    const event = await createCrewEvent({ capacity: 5 });
    await addCrew(event);
    await register(event, "guest");
    await expect(loadRsvpStatusCounts(event.id)).resolves.toMatchObject({ confirmed: 2, crew: 1 });
    const home = await loadRsvpCounts([event.id], []);
    expect(home.units.get(event.id)).toBe(1);
    expect(home.event.get(event.id)?.confirmed).toBe(2);
    expect(home.crew.get(event.id)).toBe(1);
    // The dashboard home "Next up" card fills its meter with attendees only.
    const row = await prisma.event.findUniqueOrThrow({ where: { id: event.id }, select: eventSelect });
    await expect(loadNextUp(row, home, true, new Date())).resolves.toMatchObject({ confirmed: 2, placesUsed: 1, crew: 1, capacity: 5, capacityUnits: null });
  });

  it("does not count crew as units on a TEAM event", async () => {
    const event = await createCrewEvent({ capacity: 1, registrationMode: RegistrationMode.TEAM });
    await addCrew(event);
    await expect(prisma.$transaction((tx) => countConfirmedUnits(tx, event.id))).resolves.toBe(0);
    const leader = await register(event, "leader", { mode: "create", name: `Owls ${crew.suffix}` });
    expect(leader.rsvp.status).toBe(RsvpStatus.CONFIRMED);
    await expect(capacityCount(event)).resolves.toBe(1);
  });

  it("turns a free solo registration into a crew ticket, keeping its token, and offers the freed place to the waitlist", async () => {
    const event = await createCrewEvent({ capacity: 1 });
    const attendee = await register(event, "convert");
    const waiting = await register(event, "waiting");
    expect([attendee.rsvp.status, waiting.rsvp.status]).toEqual([RsvpStatus.CONFIRMED, RsvpStatus.WAITLISTED]);

    const member = await addCrew(event, { email: attendee.email.toUpperCase(), name: "Renamed Crew" });
    expect(member.email).toBe(attendee.email);
    expect(member.rsvp).toMatchObject({ id: attendee.rsvp.id, checkInToken: attendee.rsvp.checkInToken, isCrew: true, status: RsvpStatus.CONFIRMED, guestName: "Renamed Crew" });
    await expect(prisma.rSVP.count({ where: { eventId: event.id } })).resolves.toBe(2);
    // The freed place went to the waitlist after the commit.
    await expect(prisma.rSVP.findUniqueOrThrow({ where: { id: waiting.rsvp.id } })).resolves.toMatchObject({ status: RsvpStatus.CONFIRMED });
    await expect(capacityCount(event)).resolves.toBe(1);
  });

  it("converts a waitlisted registration into a confirmed crew ticket", async () => {
    const event = await createCrewEvent({ capacity: 1 });
    await register(event, "first");
    const waiting = await register(event, "waiting");
    const member = await addCrew(event, { email: waiting.email });
    expect(member.rsvp).toMatchObject({ id: waiting.rsvp.id, status: RsvpStatus.CONFIRMED, isCrew: true });
    await expect(capacityCount(event)).resolves.toBe(1);
  });

  it("refuses a team member and an entrant with a project", async () => {
    const event = await createCrewEvent({ registrationMode: RegistrationMode.TEAM });
    const leader = await register(event, "leader", { mode: "create", name: `Larks ${crew.suffix}` });
    await expect(addCrewMemberAsOrganiser(ctxFor(event), { name: "Leader", email: leader.email })).resolves.toEqual({ ok: false, error: expect.stringContaining("registered in a team") });
    await expect(prisma.rSVP.findUniqueOrThrow({ where: { id: leader.rsvp.id } })).resolves.toMatchObject({ isCrew: false, teamId: leader.rsvp.teamId });

    const hackathon = await createCrewEvent();
    const entrant = await register(hackathon, "entrant");
    await prisma.submission.create({ data: { eventId: hackathon.id, rsvpId: entrant.rsvp.id, title: "Project" } });
    await expect(addCrewMemberAsOrganiser(ctxFor(hackathon), { name: "Entrant", email: entrant.email })).resolves.toEqual({ ok: false, error: expect.stringContaining("hackathon project") });
    await expect(prisma.eventCrewMember.count({ where: { eventId: { in: [event.id, hackathon.id] } } })).resolves.toBe(0);
  });

  it("refuses a duplicate crew email", async () => {
    const event = await createCrewEvent();
    const member = await addCrew(event);
    await expect(addCrewMemberAsOrganiser(ctxFor(event), { name: "Again", email: member.email.toUpperCase() })).resolves.toEqual({ ok: false, error: "This email is already on the crew." });
    await expect(prisma.rSVP.count({ where: { eventId: event.id } })).resolves.toBe(1);
  });

  it("updates the profile and the guest ticket together, emails a new address once, and reorders", async () => {
    const event = await createCrewEvent();
    const first = await addCrew(event);
    const second = await addCrew(event);
    const moved = crewEmail("moved");
    await expect(updateCrewMemberAsOrganiser(ctxFor(event), first.id, { name: "Renamed", email: moved, role: "Host", showOnPage: false })).resolves.toEqual({ ok: true, data: undefined });
    const updated = await prisma.eventCrewMember.findUniqueOrThrow({ where: { id: first.id }, include: { rsvp: true } });
    expect(updated).toMatchObject({ name: "Renamed", email: moved, role: "Host", showOnPage: false });
    expect(updated.rsvp).toMatchObject({ guestName: "Renamed", guestEmail: moved, attendeeKey: `guest:${moved}`, checkInToken: first.rsvp.checkInToken });
    const toMoved = () => prisma.outboxMessage.count({ where: { kind: "crew-ticket", payload: { path: ["to"], equals: moved } } });
    await expect(toMoved()).resolves.toBe(1);
    await expect(updateCrewMemberAsOrganiser(ctxFor(event), first.id, { name: "Same address", email: moved })).resolves.toMatchObject({ ok: true });
    await expect(toMoved()).resolves.toBe(1);
    await expect(updateCrewMemberAsOrganiser(ctxFor(event), second.id, { name: second.name, email: moved })).resolves.toEqual({ ok: false, error: "This email is already on the crew." });

    await expect(moveCrewMember(ctxFor(event), second.id, -1)).resolves.toEqual({ ok: true, data: undefined });
    expect((await listCrewForOrganiser(ctxFor(event))).members.map((member) => member.id)).toEqual([second.id, first.id]);
  });

  it("removes the member with their ticket, once", async () => {
    const event = await createCrewEvent();
    const member = await addCrew(event);
    await expect(removeCrewMember(ctxFor(event), member.id)).resolves.toEqual({ ok: true, data: { name: member.name } });
    await expect(prisma.rSVP.findUnique({ where: { id: member.rsvpId } })).resolves.toBeNull();
    await expect(removeCrewMember(ctxFor(event), member.id)).resolves.toEqual({ ok: false, error: "Crew member not found." });
  });

  it("cascades the crew row when its ticket is deleted", async () => {
    const event = await createCrewEvent();
    const member = await addCrew(event);
    await prisma.rSVP.delete({ where: { id: member.rsvpId } });
    await expect(prisma.eventCrewMember.findUnique({ where: { id: member.id } })).resolves.toBeNull();
  });

  it("enforces the crew ticket shape in the database: confirmed, team-less, no order or ticket type", async () => {
    const event = await createCrewEvent();
    const bad = crewEmail("bad");
    await expect(prisma.rSVP.create({ data: { eventId: event.id, guestEmail: bad, attendeeKey: `guest:${bad}`, status: RsvpStatus.WAITLISTED, isCrew: true } })).rejects.toThrow(/RSVP_crew_shape/);
    const member = await addCrew(event);
    await expect(prisma.rSVP.update({ where: { id: member.rsvpId }, data: { status: RsvpStatus.PENDING_APPROVAL } })).rejects.toThrow(/RSVP_crew_shape/);
    const ticketType = await prisma.ticketType.create({ data: { eventId: event.id, name: "Entry", priceMinor: BigInt(0) } });
    await expect(prisma.rSVP.update({ where: { id: member.rsvpId }, data: { ticketTypeId: ticketType.id } })).rejects.toThrow(/RSVP_crew_shape/);

    const teamEvent = await createCrewEvent({ registrationMode: RegistrationMode.TEAM });
    const leader = await register(teamEvent, "leader", { mode: "create", name: `Wrens ${crew.suffix}` });
    await expect(prisma.rSVP.update({ where: { id: leader.rsvp.id }, data: { isCrew: true } })).rejects.toThrow(/RSVP_crew_shape/);
  });

  it("lists only visible crew publicly, without private fields", async () => {
    const event = await createCrewEvent();
    const shown = await addCrew(event, { bio: "Runs the stage", linkedinUrl: "https://www.linkedin.com/in/someone" });
    await addCrew(event, { showOnPage: false });
    const cards = await listPublicCrew(event.id);
    expect(cards).toEqual([{ id: shown.id, name: shown.name, role: "Logistics", bio: "Runs the stage", photoUrl: null, linkedinUrl: "https://www.linkedin.com/in/someone" }]);
    for (const card of cards) {
      expect(Object.keys(card).sort()).toEqual(["bio", "id", "linkedinUrl", "name", "photoUrl", "role"]);
      expect(JSON.stringify(card)).not.toContain(shown.email);
      expect(JSON.stringify(card)).not.toContain(shown.rsvp.checkInToken);
      expect(JSON.stringify(card)).not.toContain("Vegan");
    }
  });
});
