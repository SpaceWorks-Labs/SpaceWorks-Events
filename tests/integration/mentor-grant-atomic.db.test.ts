import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ id: "", email: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: session }) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { updateEventCollaboratorPermissions, revokeEventCollaborator } from "@/app/actions/event-collaborators";
import { acceptEventCollaboratorInvite } from "@/app/actions/invite-acceptance";
import { createEventCollaboratorToken, hashEventCollaboratorToken } from "@/lib/eventCollaboratorToken";
import { addCrewMemberAsOrganiser } from "@/lib/core/crew/members";
import * as identity from "@/lib/core/crew/identity";
import { DeskError } from "@/lib/core/mentorDesk/shared";
import { bookOfficeHour, createOfficeHourSlot } from "@/lib/core/mentorDesk/officeHours";
import { syncMentorCrewAfterGrant } from "@/lib/core/mentorDesk/crewLink";
import { applyForShift } from "@/lib/volunteer/signups";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { createTeam, organiserId, orgSlug, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { addMentor, createDeskEvent, goLive, HOUR, local, teamParticipant } from "./helpers/mentorDesk";
import { whileLocked } from "./helpers/lockWait";

describe.sequential("atomic mentor grant and crew lifecycle", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(async () => { await flushWebhookEmits(); await tearDownJudgingSuite(); });

  async function fixture() {
    let event = await createDeskEvent();
    const { teamId } = await createTeam(event, "Atomic team");
    event = await goLive(event);
    event = await prisma.event.update({ where: { id: event.id }, data: { mentorsGetCrewTicket: true, volunteerShiftsEnabled: true } });
    const mentor = await addMentor(event, "atomic-mentor");
    const user = await prisma.user.update({ where: { id: mentor.userId }, data: { emailVerified: null } });
    const grant = await prisma.eventCollaborator.findUniqueOrThrow({ where: { eventId_userId: { eventId: event.id, userId: user.id } } });
    const input = { organisationSlug: orgSlug, eventId: event.id, collaboratorId: grant.id };
    const startsAt = new Date(Math.ceil((Date.now() + HOUR) / 60_000) * 60_000);
    const endsAt = new Date(startsAt.getTime() + HOUR);
    const slot = await createOfficeHourSlot(mentor, { mentorUserId: user.id, start: local(startsAt), end: local(endsAt) });
    if (!slot.ok) throw new Error(slot.error);
    expect(await bookOfficeHour(await teamParticipant(teamId), { slotId: slot.data.id, expectedVersion: 1 })).toMatchObject({ ok: true });
    return { event, user, grant, input, startsAt, endsAt };
  }

  it("refuses the whole permission save on an existing crew identity conflict, then retries successfully", async () => {
    const f = await fixture();
    const crew = await addCrewMemberAsOrganiser({ organisationId: f.event.organisationId, eventId: f.event.id, actorUserId: organiserId }, { name: "Mentor", email: f.user.email! });
    if (!crew.ok) throw new Error(crew.error);
    const shift = await prisma.volunteerShift.create({ data: {
      eventId: f.event.id, title: "Duty", startsAt: f.startsAt, endsAt: f.endsAt, signupDeadline: f.startsAt, requiresApproval: false,
    } });
    expect(await applyForShift({ eventId: f.event.id, crewMemberId: crew.data.id }, shift.id)).toMatchObject({ ok: true });
    await prisma.user.update({ where: { id: f.user.id }, data: { emailVerified: new Date() } });
    await prisma.eventCollaborator.update({ where: { id: f.grant.id }, data: { permissions: ["CHECK_IN"] } });
    session.id = organiserId;
    expect(await updateEventCollaboratorPermissions({ ...f.input, permissions: ["MENTOR"] })).toEqual({ ok: false, error: identity.CREW_LINK_CONFLICT });
    expect((await prisma.eventCollaborator.findUniqueOrThrow({ where: { id: f.grant.id } })).permissions).toEqual(["CHECK_IN"]);
    expect((await prisma.eventCrewMember.findUniqueOrThrow({ where: { id: crew.data.id } })).userId).toBeNull();
    await prisma.officeHourBooking.updateMany({ where: { slot: { eventId: f.event.id } }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "organiser" } });
    expect(await updateEventCollaboratorPermissions({ ...f.input, permissions: ["MENTOR"] })).toEqual({ ok: true });
    expect((await prisma.eventCrewMember.findUniqueOrThrow({ where: { id: crew.data.id } })).userId).toBe(f.user.id);
    expect(await revokeEventCollaborator(f.input)).toEqual({ ok: true });
    // A pre-existing crew ticket belongs to its organiser, never to the hook.
    expect(await prisma.eventCrewMember.count({ where: { id: crew.data.id } })).toBe(1);
  });

  it.each(["permissions", "invite"] as const)("rolls back %s, profile, ticket and queued mail when the final profile link refuses", async (via) => {
    const f = await fixture();
    await prisma.eventCollaborator.update({ where: { id: f.grant.id }, data: { permissions: ["CHECK_IN"] } });
    await prisma.mentorProfile.delete({ where: { eventId_userId: { eventId: f.event.id, userId: f.user.id } } });
    const token = createEventCollaboratorToken();
    const invite = await prisma.eventCollaboratorInvite.create({ data: {
      eventId: f.event.id, email: f.user.email!, tokenHash: hashEventCollaboratorToken(token), permissions: ["MENTOR"],
      createdByUserId: organiserId, expiresAt: new Date(Date.now() + HOUR),
    } });
    const attempt = () => via === "permissions"
      ? updateEventCollaboratorPermissions({ ...f.input, permissions: ["MENTOR"] })
      : acceptEventCollaboratorInvite(token);
    session.id = via === "permissions" ? organiserId : f.user.id;
    session.email = f.user.email!;
    const emails = await prisma.outboxMessage.count({ where: { kind: "crew-ticket", payload: { path: ["to"], equals: f.user.email! } } });
    // Inject a refusal at the final link, after real ticket creation, to prove
    // the transaction boundary covers every earlier write and queued email.
    const link = vi.spyOn(identity, "linkMentorCrew").mockRejectedValueOnce(new DeskError(identity.CREW_LINK_CONFLICT));
    try {
      expect(await attempt()).toEqual({ ok: false, error: identity.CREW_LINK_CONFLICT });
    } finally { link.mockRestore(); }
    expect((await prisma.eventCollaborator.findUniqueOrThrow({ where: { id: f.grant.id } })).permissions).toEqual(["CHECK_IN"]);
    expect(await prisma.mentorProfile.count({ where: { eventId: f.event.id, userId: f.user.id } })).toBe(0);
    expect(await prisma.eventCrewMember.count({ where: { eventId: f.event.id } })).toBe(0);
    expect(await prisma.rSVP.count({ where: { eventId: f.event.id, isCrew: true } })).toBe(0);
    expect(await prisma.outboxMessage.count({ where: { kind: "crew-ticket", payload: { path: ["to"], equals: f.user.email! } } })).toBe(emails);
    expect(await prisma.eventCollaboratorInvite.findUniqueOrThrow({ where: { id: invite.id } })).toMatchObject({ usedAt: null, usedByUserId: null });
    expect(await attempt()).toMatchObject({ ok: true });
    const profile = await prisma.mentorProfile.findUniqueOrThrow({ where: { eventId_userId: { eventId: f.event.id, userId: f.user.id } } });
    expect(profile.crewMemberId).not.toBeNull();
    session.id = organiserId;
    expect(await revokeEventCollaborator(f.input)).toEqual({ ok: true });
    expect(await prisma.eventCrewMember.count({ where: { eventId: f.event.id } })).toBe(0);
    expect(await prisma.rSVP.count({ where: { eventId: f.event.id, isCrew: true } })).toBe(0);
  });

  it("publishes no unowned ticket while the hook waits for its person lock and removes its ticket with MENTOR", async () => {
    const f = await fixture();
    await whileLocked((tx) => tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${f.user.id} FOR NO KEY UPDATE`,
      () => syncMentorCrewAfterGrant({ eventId: f.event.id, userId: f.user.id, before: [], after: ["MENTOR"], actorUserId: organiserId }),
      { beforeRelease: async () => {
        expect(await prisma.eventCrewMember.count({ where: { eventId: f.event.id } })).toBe(0);
        expect(await prisma.rSVP.count({ where: { eventId: f.event.id, isCrew: true } })).toBe(0);
      } });
    const profile = await prisma.mentorProfile.findUniqueOrThrow({ where: { eventId_userId: { eventId: f.event.id, userId: f.user.id } } });
    expect(profile.crewMemberId).not.toBeNull();
    session.id = organiserId;
    expect(await updateEventCollaboratorPermissions({ ...f.input, permissions: ["CHECK_IN"] })).toEqual({ ok: true });
    expect(await prisma.eventCrewMember.count({ where: { eventId: f.event.id } })).toBe(0);
    expect(await prisma.rSVP.count({ where: { eventId: f.event.id, isCrew: true } })).toBe(0);
  });
});
