import { randomUUID } from "node:crypto";
import { EventPermission, RegistrationMode, type Event } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { syncMentorGrantLocked } from "@/lib/core/mentorDesk/grant";
import { syncMentorCrewAfterGrant } from "@/lib/core/mentorDesk/crewLink";
import { issueContributorCertificate, loadContributorCertificate } from "@/lib/volunteer/certificates";
import { hasMentoringEvidence } from "@/lib/volunteer/mentoring";
import { createCrewEvent, crew, crewEmail, setUpCrewOrgs, tearDownCrewOrgs } from "./helpers/crew";
import { staffFor, tearDownUsers, volunteer } from "./helpers/volunteers";

/* Mentor Desk links (docs/VOLUNTEERS.md): mentoring evidence for certificates, revoked with the grant; mentor crew places. */

const users: string[] = [];

async function mentorOn(event: Event, label: string, verified = true) {
  const user = await prisma.user.create({ data: { name: `Mentor ${label}`, email: crewEmail(label), emailVerified: verified ? new Date() : null } });
  users.push(user.id);
  await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: user.id, permissions: [EventPermission.MENTOR] } });
  await prisma.mentorProfile.create({ data: { eventId: event.id, userId: user.id } });
  return user;
}

async function team(event: Event) {
  return prisma.team.create({ data: { eventId: event.id, name: `Owls ${randomUUID().slice(0, 6)}`, nameKey: randomUUID(), status: "CONFIRMED", joinToken: randomUUID(), manageTokenHash: randomUUID() } });
}

describe.sequential("volunteer certificates and the Mentor Desk", () => {
  beforeAll(() => setUpCrewOrgs("vmentor"));
  afterAll(async () => {
    await flushWebhookEmits();
    await tearDownUsers(users);
    await tearDownCrewOrgs();
  });

  it("counts only real mentoring by a current MENTOR grant: an activated assignment, not a proposal", async () => {
    const event = await createCrewEvent({ registrationMode: RegistrationMode.TEAM });
    const user = await mentorOn(event, "evidence");
    const { member } = await volunteer(event, { email: user.email, kind: "MENTOR" });
    await prisma.eventCrewMember.update({ where: { id: member.id }, data: { userId: user.id } });
    const owls = await team(event);
    await prisma.mentorTeamAssignment.create({ data: { eventId: event.id, mentorUserId: user.id, teamId: owls.id, mode: "MANUAL", status: "PROPOSED" } });
    await expect(hasMentoringEvidence(prisma, event.id, user.id)).resolves.toBe(false);
    await expect(issueContributorCertificate(staffFor(event), member.id)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("mentoring") });
    await prisma.mentorTeamAssignment.updateMany({ where: { mentorUserId: user.id }, data: { status: "ACTIVE", activatedAt: new Date() } });
    await expect(issueContributorCertificate(staffFor(event), member.id)).resolves.toMatchObject({ ok: true });
    const certificate = await prisma.contributorCertificate.findFirstOrThrow({ where: { crewMemberId: member.id } });
    expect(certificate).toMatchObject({ minutes: 0, kind: "MENTOR" });
    await expect(loadContributorCertificate(certificate.token)).resolves.not.toBeNull();

    // Removing the MENTOR grant removes the evidence and revokes the certificate in the same transaction.
    await prisma.$transaction(async (tx) => {
      await tx.eventCollaborator.updateMany({ where: { eventId: event.id, userId: user.id }, data: { permissions: [] } });
      await syncMentorGrantLocked(tx, event.id, user.id, [EventPermission.MENTOR], [], crew.organiserId);
    });
    await expect(prisma.contributorCertificate.findUniqueOrThrow({ where: { id: certificate.id } })).resolves.toMatchObject({ revokedReason: "mentoring_evidence_removed" });
    await expect(loadContributorCertificate(certificate.token)).resolves.toBeNull();
    await expect(issueContributorCertificate(staffFor(event), member.id)).resolves.toMatchObject({ ok: false });
  });

  it("gives a mentor's crew place the MENTOR kind and links it to the mentor's account", async () => {
    const event = await createCrewEvent({ registrationMode: RegistrationMode.TEAM });
    await prisma.event.update({ where: { id: event.id }, data: { mentorsGetCrewTicket: true } });
    const user = await mentorOn(event, "crewlink");
    await syncMentorCrewAfterGrant({ eventId: event.id, userId: user.id, before: [], after: [EventPermission.MENTOR], actorUserId: crew.organiserId });
    const place = await prisma.eventCrewMember.findFirstOrThrow({ where: { eventId: event.id, email: user.email! } });
    expect(place).toMatchObject({ kind: "MENTOR", userId: user.id, role: "Mentor", showOnPage: false });
    await expect(prisma.mentorProfile.findFirstOrThrow({ where: { eventId: event.id, userId: user.id } })).resolves.toMatchObject({ crewMemberId: place.id });

    // An existing crew place keeps its kind but is linked to the account.
    const other = await mentorOn(event, "existing", false);
    const { member } = await volunteer(event, { email: other.email, kind: "VOLUNTEER" });
    expect(member.userId).toBeNull();
    await prisma.user.update({ where: { id: other.id }, data: { emailVerified: new Date() } });
    await syncMentorCrewAfterGrant({ eventId: event.id, userId: other.id, before: [], after: [EventPermission.MENTOR], actorUserId: crew.organiserId });
    await expect(prisma.eventCrewMember.findUniqueOrThrow({ where: { id: member.id } })).resolves.toMatchObject({ kind: "VOLUNTEER", userId: other.id });

    // An unverified account is never linked: the link would open the crew ticket on mobile.
    const unverified = await mentorOn(event, "unverified", false);
    await syncMentorCrewAfterGrant({ eventId: event.id, userId: unverified.id, before: [], after: [EventPermission.MENTOR], actorUserId: crew.organiserId });
    await expect(prisma.eventCrewMember.findFirstOrThrow({ where: { eventId: event.id, email: unverified.email! } })).resolves.toMatchObject({ kind: "MENTOR", userId: null });
  });
});
