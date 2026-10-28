import { EventPrivacyType, RegistrationMode, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { restoreRsvp } from "@/app/actions/rsvp-admin";
import { lookupAttendeesForCheckIn } from "@/app/actions/checkin";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import {
  addTeamMemberByLeader,
  countEventTeamsForOrganiser,
  disbandTeam,
  listEventTeamsForOrganiser,
  ORGANISER_TEAMS_PAGE_SIZE,
  organiserDeleteTeam,
  resolveOrganiserEvent,
  transitionTeamStatus,
} from "@/lib/core/teams";
import { countConfirmedForEvent } from "@/lib/rsvpCapacity";
import { loadRsvpCounts } from "@/lib/dashboardHome";
import {
  actingAs,
  createEvent,
  createTeam,
  joinTeam,
  leaderAuth,
  orgSlug,
  organisationId,
  organiser,
  organiserId,
  otherOrganisationId,
  otherOrganiserId,
  registerOk,
  setUpTeams,
  suffix,
  tearDownTeams,
} from "./helpers/teams";

// The organiser Teams view, the check-in desk, registration webhooks and dashboard unit counts.
const as = actingAs(identity);

describe.sequential("team registration integration", () => {
  beforeAll(setUpTeams);

  afterAll(tearDownTeams);

  it("pages and searches the organiser Teams view within one event", async () => {
    const event = await createEvent({ teamMinSize: 2, teamMaxSize: 4 });
    const otherEvent = await createEvent();
    const ctx = await organiser(event);
    const total = ORGANISER_TEAMS_PAGE_SIZE + 3;
    for (let i = 0; i < total; i += 1) await createTeam(event, `Squad ${String(i).padStart(3, "0")}${i === 7 ? " 100%_off" : ""}`);
    const { team: grown } = await createTeam(event, "Grown ups");
    const member = await joinTeam(event, grown.id, "Zebedee");
    await createTeam(otherEvent, "Squad elsewhere");

    const first = await listEventTeamsForOrganiser(ctx);
    expect(first.teams).toHaveLength(ORGANISER_TEAMS_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    const second = await listEventTeamsForOrganiser(ctx, { cursor: first.nextCursor });
    expect(second.nextCursor).toBeNull();
    const all = [...first.teams, ...second.teams];
    expect(all).toHaveLength(total + 1);
    expect(new Set(all.map((team) => team.id)).size).toBe(total + 1);
    expect(all.every((team) => team.name !== "Squad elsewhere")).toBe(true);

    // Team names (wildcards literal) and member names/emails, in this event only.
    await expect(listEventTeamsForOrganiser(ctx, { query: "squad 00" })).resolves.toMatchObject({ nextCursor: null });
    expect((await listEventTeamsForOrganiser(ctx, { query: "squad 00" })).teams).toHaveLength(10);
    expect((await listEventTeamsForOrganiser(ctx, { query: "100%_" })).teams.map((team) => team.name)).toEqual(["Squad 007 100%_off"]);
    expect((await listEventTeamsForOrganiser(ctx, { query: "%" })).teams.map((team) => team.name)).toEqual(["Squad 007 100%_off"]);
    expect((await listEventTeamsForOrganiser(ctx, { query: member.email.toUpperCase() })).teams.map((team) => team.id)).toEqual([grown.id]);
    expect((await listEventTeamsForOrganiser(ctx, { query: "elsewhere" })).teams).toEqual([]);

    // Filters and their counts.
    const incomplete = await listEventTeamsForOrganiser(ctx, { filter: "incomplete" });
    expect(incomplete.teams).toHaveLength(ORGANISER_TEAMS_PAGE_SIZE);
    expect(incomplete.teams.every((team) => team.incomplete)).toBe(true);
    await expect(countEventTeamsForOrganiser(ctx)).resolves.toMatchObject({ all: total + 1, going: total + 1, incomplete: total, approve: 0 });
    await expect(listEventTeamsForOrganiser(ctx, { filter: "approve" })).resolves.toEqual({ teams: [], nextCursor: null });

    // Another organisation's admin gets nothing for this event.
    await expect(resolveOrganiserEvent(otherOrganiserId, orgSlug, event.id)).resolves.toBeNull();
    const foreignCtx = { ...ctx, organisationId: otherOrganisationId };
    await expect(listEventTeamsForOrganiser(foreignCtx)).resolves.toEqual({ teams: [], nextCursor: null });
  });

  it("finds members by team name at the check-in desk, within the event", async () => {
    const event = await createEvent({ capacity: 10 });
    const otherEvent = await createEvent({ capacity: 10 });
    const { leader } = await createTeam(event, "Quokka Coders");
    const member = await joinTeam(event, (await prisma.rSVP.findUniqueOrThrow({ where: { id: leader.rsvpId } })).teamId!);
    await createTeam(otherEvent, "Quokka Elsewhere");

    const result = await as(organiserId, () => lookupAttendeesForCheckIn({ organisationSlug: orgSlug, eventId: event.id, query: "quokka" }));
    if (!result.ok || !result.data) throw new Error(result.ok ? "no rows" : result.error);
    expect(result.data.rows.map((row) => row.rsvpId).sort()).toEqual([leader.rsvpId, member.rsvpId].sort());
    expect(result.data.rows.every((row) => row.teamName === "Quokka Coders")).toBe(true);
  });

  it("sends per-member registration webhooks for whole-team changes, deletes, disbanding and undo", async () => {
    // Endpoints are read straight from the database; nothing is delivered here.
    await prisma.webhookEndpoint.create({
      data: {
        organisationId,
        url: "https://hooks.example.test/teams",
        eventTypes: ["registration.created", "registration.status_changed"],
        secretEncrypted: "v1.placeholder.placeholder.placeholder",
      },
    });
    const since = new Date();
    async function statusChanges(rsvpIds: string[]) {
      await flushWebhookEmits();
      const rows = await prisma.webhookDelivery.findMany({
        where: { organisationId, eventType: "registration.status_changed", createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
      });
      return rows
        .map((row) => (row.payload as { data: { registration: { id: string; status: string }; previousStatus: string | null } }).data)
        .filter((data) => rsvpIds.includes(data.registration.id))
        .map((data) => ({ id: data.registration.id, status: data.registration.status, previousStatus: data.previousStatus }));
    }
    const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

    // Approval-required event: approving a team sends one change per member.
    const approval = await createEvent({ capacity: 5, privacyType: EventPrivacyType.APPROVAL_REQUIRED });
    const pending = await createTeam(approval, "Hook approvers");
    const pendingMember = await joinTeam(approval, pending.team.id);
    await expect(transitionTeamStatus(await organiser(approval), pending.team.id, "approve")).resolves.toMatchObject({ ok: true });
    expect(byId(await statusChanges([pending.leader.rsvpId, pendingMember.rsvpId]))).toEqual(byId([
      { id: pending.leader.rsvpId, status: RsvpStatus.CONFIRMED, previousStatus: RsvpStatus.PENDING_APPROVAL },
      { id: pendingMember.rsvpId, status: RsvpStatus.CONFIRMED, previousStatus: RsvpStatus.PENDING_APPROVAL },
    ]));

    // One unit: team A is confirmed, team B waits.
    const event = await createEvent({ capacity: 1 });
    const ctx = await organiser(event);
    const a = await createTeam(event, "Hook alpha");
    const added = await addTeamMemberByLeader(await leaderAuth(a.team.id), { name: "Added Person", email: `hook-added-${suffix}@example.test` });
    if (!added.ok || !added.data) throw new Error("leader add failed");
    const b = await createTeam(event, "Hook bravo");
    const bMember = await joinTeam(event, b.team.id);
    expect(b.leader.status).toBe(RsvpStatus.WAITLISTED);
    await flushWebhookEmits();
    const created = await prisma.webhookDelivery.findMany({ where: { organisationId, eventType: "registration.created", createdAt: { gte: since } } });
    expect(created.some((row) => (row.payload as { data: { registration: { id: string } } }).data.registration.id === added.data!.rsvpId)).toBe(true);

    // Deleting team A removes its members and promotes team B as a whole.
    const deleted = await organiserDeleteTeam(ctx, a.team.id);
    if (!deleted.ok || !deleted.data) throw new Error("team delete failed");
    expect(byId(await statusChanges([a.leader.rsvpId, added.data.rsvpId]))).toEqual(byId([
      { id: a.leader.rsvpId, status: "REMOVED", previousStatus: RsvpStatus.CONFIRMED },
      { id: added.data.rsvpId, status: "REMOVED", previousStatus: RsvpStatus.CONFIRMED },
    ]));
    expect(byId(await statusChanges([b.leader.rsvpId, bMember.rsvpId]))).toEqual(byId([
      { id: b.leader.rsvpId, status: RsvpStatus.CONFIRMED, previousStatus: RsvpStatus.WAITLISTED },
      { id: bMember.rsvpId, status: RsvpStatus.CONFIRMED, previousStatus: RsvpStatus.WAITLISTED },
    ]));

    // Disbanding team B cancels both registrations.
    await expect(disbandTeam(await leaderAuth(b.team.id))).resolves.toMatchObject({ ok: true });
    const bChanges = await statusChanges([b.leader.rsvpId, bMember.rsvpId]);
    expect(byId(bChanges.filter((change) => change.status === "CANCELLED"))).toEqual(byId([
      { id: b.leader.rsvpId, status: "CANCELLED", previousStatus: RsvpStatus.CONFIRMED },
      { id: bMember.rsvpId, status: "CANCELLED", previousStatus: RsvpStatus.CONFIRMED },
    ]));

    // Undoing team A's deletion restores both members, previously REMOVED.
    await expect(as(organiserId, () => restoreRsvp({ organisationSlug: orgSlug, undoId: deleted.data!.undoId }))).resolves.toEqual({ ok: true });
    const aChanges = await statusChanges([a.leader.rsvpId, added.data.rsvpId]);
    expect(byId(aChanges.filter((change) => change.previousStatus === "REMOVED"))).toEqual(byId([
      { id: a.leader.rsvpId, status: RsvpStatus.CONFIRMED, previousStatus: "REMOVED" },
      { id: added.data.rsvpId, status: RsvpStatus.CONFIRMED, previousStatus: "REMOVED" },
    ]));

    // Payloads stay minimal: no team name, emails or tokens.
    const payloads = JSON.stringify((await prisma.webhookDelivery.findMany({ where: { organisationId, createdAt: { gte: since } } })).map((row) => row.payload));
    expect(payloads).not.toContain("Hook alpha");
    expect(payloads).not.toContain("@example.test");
    expect(payloads).not.toContain(a.leader.ticketToken);
    await prisma.webhookEndpoint.deleteMany({ where: { organisationId } });
  });

  it("dashboard counts compare units, not people, with capacity on TEAM events", async () => {
    const event = await createEvent({ capacity: 3 });
    const alpha = await createTeam(event, "Count Alpha");
    await joinTeam(event, alpha.team.id);
    await joinTeam(event, alpha.team.id);
    const beta = await createTeam(event, "Count Beta");
    await joinTeam(event, beta.team.id);
    await registerOk(event, "count-solo");
    // 6 people in 3 units: the event is full in units.
    await expect(prisma.rSVP.count({ where: { eventId: event.id, status: RsvpStatus.CONFIRMED } })).resolves.toBe(6);
    await expect(countConfirmedForEvent(event.id, event.registrationMode)).resolves.toBe(3);
    const counts = await loadRsvpCounts([event.id], []);
    expect(counts.event.get(event.id)?.confirmed).toBe(6);
    expect(counts.units.get(event.id)).toBe(3);

    // INDIVIDUAL events: units equal confirmed people.
    const individual = await createEvent({ capacity: 5, registrationMode: RegistrationMode.INDIVIDUAL });
    await registerOk(individual, "count-one");
    await registerOk(individual, "count-two");
    await expect(countConfirmedForEvent(individual.id, individual.registrationMode)).resolves.toBe(2);
    const individualCounts = await loadRsvpCounts([individual.id], []);
    expect(individualCounts.units.get(individual.id)).toBe(2);
  });
});
