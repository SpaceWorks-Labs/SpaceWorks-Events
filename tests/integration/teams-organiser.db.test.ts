import { RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { deleteRsvp, restoreRsvp } from "@/app/actions/rsvp-admin";
import {
  addTeamMemberByLeader,
  organiserDeleteTeam,
  organiserMoveMember,
  organiserRenameTeam,
  removeTeamMember,
  resolveOrganiserEvent,
} from "@/lib/core/teams";
import {
  actingAs,
  createEvent,
  createTeam,
  expectTeamInvariants,
  joinTeam,
  leaderAuth,
  orgSlug,
  organiser,
  organiserId,
  otherOrganiserId,
  registerOk,
  setUpTeams,
  statusOf,
  suffix,
  tearDownTeams,
} from "./helpers/teams";

// Organiser moves, removals, deletes and the undo that restores teams, members and their check-in list records.
const as = actingAs(identity);

describe.sequential("team registration integration", () => {
  beforeAll(setUpTeams);

  afterAll(tearDownTeams);

  it("keeps member statuses equal to the team status through organiser moves, removals, and deletes", async () => {
    const event = await createEvent({ capacity: 2, teamMaxSize: 3 });
    const ctx = await organiser(event);
    const confirmed = await createTeam(event, "Confirmed crew");
    const solo = await registerOk(event, "solo");
    const waitlisted = await createTeam(event, "Waitlisted crew");
    const waitlistedMember = await joinTeam(event, waitlisted.team.id);
    expect([confirmed.leader.status, solo.status, waitlisted.leader.status]).toEqual([
      RsvpStatus.CONFIRMED,
      RsvpStatus.CONFIRMED,
      RsvpStatus.WAITLISTED,
    ]);

    // Moving the confirmed solo into a team frees their unit: the waitlisted team is promoted.
    await expect(organiserMoveMember(ctx, { rsvpId: solo.rsvpId, targetTeamId: confirmed.team.id })).resolves.toEqual({
      ok: true,
      data: { status: RsvpStatus.CONFIRMED },
    });
    await expect(prisma.team.findUniqueOrThrow({ where: { id: waitlisted.team.id } })).resolves.toMatchObject({ status: RsvpStatus.CONFIRMED });
    await expectTeamInvariants(event);

    // Moving a member between teams rechecks the target size.
    await expect(organiserMoveMember(ctx, { rsvpId: waitlistedMember.rsvpId, targetTeamId: confirmed.team.id })).resolves.toEqual({
      ok: true,
      data: { status: RsvpStatus.CONFIRMED },
    });
    await expect(organiserMoveMember(ctx, { rsvpId: waitlisted.leader.rsvpId, targetTeamId: confirmed.team.id })).resolves.toEqual({
      ok: false,
      error: "That team is already full.",
    });
    await expectTeamInvariants(event);

    await expect(removeTeamMember(await leaderAuth(confirmed.team.id), solo.rsvpId)).resolves.toEqual({ ok: true });
    await expectTeamInvariants(event);

    const added = await addTeamMemberByLeader(await leaderAuth(waitlisted.team.id), { name: "Added Member", email: `added-member-${suffix}@example.test` });
    expect(added).toMatchObject({ ok: true, data: { status: RsvpStatus.CONFIRMED } });
    await expectTeamInvariants(event);

    const deleted = await organiserDeleteTeam(ctx, waitlisted.team.id);
    expect(deleted).toMatchObject({ ok: true, data: { removed: 2 } });
    await expect(prisma.team.findUnique({ where: { id: waitlisted.team.id } })).resolves.toBeNull();
    await expectTeamInvariants(event);

    await expect(organiserRenameTeam(ctx, confirmed.team.id, "Renamed crew")).resolves.toEqual({ ok: true, data: { name: "Renamed crew" } });
    await expectTeamInvariants(event);
  });

  it("restores a deleted team or member through the existing undo, only while a unit is free", async () => {
    const event = await createEvent({ capacity: 1 });
    const ctx = await organiser(event);
    const { leader, team } = await createTeam(event, "Undo crew");
    const member = await joinTeam(event, team.id);

    // A deleted member goes back into their team, taking its status.
    const memberUndo = await as(organiserId, () => deleteRsvp({ organisationSlug: orgSlug, eventId: event.id, rsvpId: member.rsvpId }));
    if (!memberUndo.ok || !memberUndo.data) throw new Error("member delete failed");
    await expectTeamInvariants(event);
    await expect(as(organiserId, () => restoreRsvp({ organisationSlug: orgSlug, undoId: memberUndo.data!.undoId }))).resolves.toEqual({ ok: true });
    // Restore keeps the ticket (check-in token), not the row id.
    await expect(prisma.rSVP.findUniqueOrThrow({ where: { checkInToken: member.ticketToken } })).resolves.toMatchObject({ teamId: team.id, status: RsvpStatus.CONFIRMED });
    await expectTeamInvariants(event);

    const deleted = await organiserDeleteTeam(ctx, team.id);
    if (!deleted.ok || !deleted.data) throw new Error("team delete failed");
    expect(deleted.data.removed).toBe(2);
    const other = await createTeam(event, "Took the unit");
    expect(other.leader.status).toBe(RsvpStatus.CONFIRMED);
    await expect(as(organiserId, () => restoreRsvp({ organisationSlug: orgSlug, undoId: deleted.data!.undoId }))).resolves.toEqual({
      ok: false,
      error: "This team cannot be restored because the event is now at capacity.",
    });
    // Another organisation's admin cannot use the undo.
    await expect(as(otherOrganiserId, () => restoreRsvp({ organisationSlug: orgSlug, undoId: deleted.data!.undoId }))).resolves.toMatchObject({ ok: false });

    await expect(organiserDeleteTeam(ctx, other.team.id)).resolves.toMatchObject({ ok: true });
    await expect(as(organiserId, () => restoreRsvp({ organisationSlug: orgSlug, undoId: deleted.data!.undoId }))).resolves.toEqual({ ok: true });
    await expect(prisma.team.findUniqueOrThrow({ where: { id: team.id } })).resolves.toMatchObject({
      status: RsvpStatus.CONFIRMED,
      leaderRsvpId: leader.rsvpId,
    });
    await expect(prisma.rSVP.count({ where: { teamId: team.id } })).resolves.toBe(2);
    await expectTeamInvariants(event);
  });

  it("does not release a checked-in person's unit by moving them into a team without a place", async () => {
    const event = await createEvent({ capacity: 2 });
    const ctx = await organiser(event);
    const solo = await registerOk(event, "solo");
    const confirmed = await createTeam(event, "Confirmed place");
    const waitlisted = await createTeam(event, "Waiting place");
    const nextSolo = await registerOk(event, "next");
    expect([solo.status, confirmed.leader.status, waitlisted.leader.status, nextSolo.status]).toEqual([
      RsvpStatus.CONFIRMED,
      RsvpStatus.CONFIRMED,
      RsvpStatus.WAITLISTED,
      RsvpStatus.WAITLISTED,
    ]);
    await prisma.rSVP.update({ where: { id: solo.rsvpId }, data: { checkedInAt: new Date() } });

    await expect(organiserMoveMember(ctx, { rsvpId: solo.rsvpId, targetTeamId: waitlisted.team.id })).resolves.toEqual({
      ok: false,
      error: "This person has already checked in, so they can only move to a confirmed team.",
    });
    await expect(statusOf(solo.rsvpId)).resolves.toBe(RsvpStatus.CONFIRMED);
    await expect(prisma.team.findUniqueOrThrow({ where: { id: waitlisted.team.id } })).resolves.toMatchObject({ status: RsvpStatus.WAITLISTED });
    await expectTeamInvariants(event);

    // Into a confirmed team they keep a place, so the move is allowed.
    await expect(organiserMoveMember(ctx, { rsvpId: solo.rsvpId, targetTeamId: confirmed.team.id })).resolves.toEqual({
      ok: true,
      data: { status: RsvpStatus.CONFIRMED },
    });
    await expectTeamInvariants(event);
  });

  it("can undo removing a team's only member by restoring the whole team", async () => {
    const event = await createEvent({ capacity: 3 });
    const { leader, team } = await createTeam(event, "Lone crew");

    const undo = await as(organiserId, () => deleteRsvp({ organisationSlug: orgSlug, eventId: event.id, rsvpId: leader.rsvpId }));
    if (!undo.ok || !undo.data) throw new Error("delete failed");
    await expect(prisma.team.findUnique({ where: { id: team.id } })).resolves.toBeNull();
    await expectTeamInvariants(event);

    await expect(as(organiserId, () => restoreRsvp({ organisationSlug: orgSlug, undoId: undo.data!.undoId }))).resolves.toEqual({ ok: true });
    await expect(prisma.team.findUniqueOrThrow({ where: { id: team.id } })).resolves.toMatchObject({ status: RsvpStatus.CONFIRMED, leaderRsvpId: leader.rsvpId });
    await expect(prisma.rSVP.findUniqueOrThrow({ where: { checkInToken: leader.ticketToken } })).resolves.toMatchObject({ teamId: team.id, status: RsvpStatus.CONFIRMED });
    await expectTeamInvariants(event);
  });

  it("restores members' custom check-in list records when a team deletion is undone", async () => {
    const event = await createEvent({ capacity: 5 });
    const ctx = await organiser(event);
    const { leader, team } = await createTeam(event, "Listed crew");
    const member = await joinTeam(event, team.id);
    const swag = await prisma.checkInList.create({ data: { eventId: event.id, name: "Swag" } });
    const dinner = await prisma.checkInList.create({ data: { eventId: event.id, name: "Dinner", sortOrder: 1 } });
    const at = new Date("2035-01-01T11:00:00.000Z");
    await prisma.checkInListRecord.createMany({ data: [
      { listId: swag.id, rsvpId: leader.rsvpId, source: "online", checkedInAt: at },
      { listId: swag.id, rsvpId: member.rsvpId, source: "mobile-scan", checkedInAt: at },
      { listId: dinner.id, rsvpId: member.rsvpId, source: "online", checkedInAt: at },
    ] });

    const deleted = await organiserDeleteTeam(ctx, team.id);
    if (!deleted.ok || !deleted.data) throw new Error("team delete failed");
    await expect(prisma.checkInListRecord.count({ where: { listId: { in: [swag.id, dinner.id] } } })).resolves.toBe(0);
    // A list removed meanwhile is not recreated; the others come back as they were.
    await prisma.checkInList.delete({ where: { id: dinner.id } });
    await expect(as(organiserId, () => restoreRsvp({ organisationSlug: orgSlug, undoId: deleted.data!.undoId }))).resolves.toEqual({ ok: true });
    const restored = await prisma.checkInListRecord.findMany({ where: { listId: swag.id }, orderBy: { source: "asc" } });
    expect(restored.map((record) => ({ rsvpId: record.rsvpId, source: record.source, checkedInAt: record.checkedInAt.toISOString() }))).toEqual([
      { rsvpId: member.rsvpId, source: "mobile-scan", checkedInAt: at.toISOString() },
      { rsvpId: leader.rsvpId, source: "online", checkedInAt: at.toISOString() },
    ]);
    await expectTeamInvariants(event);

    // Removing a team's last member (whole-team undo snapshot) keeps them too.
    const solo = await createTeam(event, "Listed solo");
    await prisma.checkInListRecord.create({ data: { listId: swag.id, rsvpId: solo.leader.rsvpId, source: "mobile-manual", checkedInAt: at } });
    const undo = await as(organiserId, () => deleteRsvp({ organisationSlug: orgSlug, eventId: event.id, rsvpId: solo.leader.rsvpId }));
    if (!undo.ok || !undo.data) throw new Error("delete failed");
    await expect(prisma.team.findUnique({ where: { id: solo.team.id } })).resolves.toBeNull();
    await expect(as(organiserId, () => restoreRsvp({ organisationSlug: orgSlug, undoId: undo.data!.undoId }))).resolves.toEqual({ ok: true });
    await expect(prisma.checkInListRecord.findMany({ where: { rsvpId: solo.leader.rsvpId }, select: { listId: true, source: true } })).resolves.toEqual([
      { listId: swag.id, source: "mobile-manual" },
    ]);
  });

  it("refuses a team undo once the deleter's registration access is revoked", async () => {
    const event = await createEvent({ capacity: 5 });
    const collaborator = await prisma.user.create({ data: { name: "Desk volunteer", email: `desk-${suffix}@example.test` } });
    try {
      const grant = await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: collaborator.id, permissions: ["MANAGE_REGISTRATIONS"] } });
      const ctx = await resolveOrganiserEvent(collaborator.id, orgSlug, event.id);
      if (!ctx) throw new Error("collaborator context missing");
      const { team } = await createTeam(event, "Revoked crew");
      const deleted = await organiserDeleteTeam(ctx, team.id);
      if (!deleted.ok || !deleted.data) throw new Error("team delete failed");

      await prisma.eventCollaborator.delete({ where: { id: grant.id } });
      await expect(as(collaborator.id, () => restoreRsvp({ organisationSlug: orgSlug, undoId: deleted.data!.undoId }))).resolves.toEqual({
        ok: false,
        error: "You do not have permission to restore RSVPs.",
      });
      await expect(prisma.team.findUnique({ where: { id: team.id } })).resolves.toBeNull();
      await expect(prisma.rsvpDeletionUndo.count({ where: { id: deleted.data.undoId } })).resolves.toBe(1);
    } finally {
      await prisma.user.delete({ where: { id: collaborator.id } });
    }
  });
});
