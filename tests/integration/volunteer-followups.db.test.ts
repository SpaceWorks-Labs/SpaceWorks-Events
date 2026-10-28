import { randomUUID } from "node:crypto";
import { EventPermission, RegistrationMode } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { linkCrewAccount, updateCrewMemberAsOrganiser } from "@/lib/core/crew";
import { applyForShift } from "@/lib/volunteer/signups";
import { updateShift } from "@/lib/volunteer/shifts";
import { checkInToShift, markNoShow } from "@/lib/volunteer/attendance";
import { verifyHours } from "@/lib/volunteer/hours";
import { issueContributorCertificate, loadContributorCertificate } from "@/lib/volunteer/certificates";
import { recheckMentoringCertificatesLocked } from "@/lib/volunteer/mentoring";
import { ownCrewTicket } from "@/lib/mobile/volunteers";
import { createCrewEvent, crew, crewEmail, ctxFor, setUpCrewOrgs, tearDownCrewOrgs } from "./helpers/crew";
import { makeShift, secondAdmin, shiftsEvent, staffFor, tearDownUsers, volunteer, workedHours } from "./helpers/volunteers";

/* Review follow-ups (docs/VOLUNTEERS.md): sticky account links, lock order and state guards, shift edits, the hours insert guard, evidence. */

const users: string[] = [];
const MINUTE = 60_000;

describe.sequential("volunteer follow-ups", () => {
  beforeAll(() => setUpCrewOrgs("vfollow"));
  afterAll(async () => {
    await flushWebhookEmits();
    await tearDownUsers(users);
    await tearDownCrewOrgs();
  });

  it("never lets an organiser unlink their own crew record by changing its email", async () => {
    const event = await shiftsEvent();
    await prisma.user.update({ where: { id: crew.organiserId }, data: { emailVerified: new Date() } });
    const organiser = await prisma.user.findUniqueOrThrow({ where: { id: crew.organiserId } });
    const { member } = await volunteer(event, { email: organiser.email });
    expect(member.userId).toBe(crew.organiserId);
    const hours = await workedHours(event, member.id, 60);
    // The exploit: move the guest crew ticket to another address, then verify one's own hours.
    await expect(updateCrewMemberAsOrganiser(ctxFor(event), member.id, { name: "Me", email: crewEmail("elsewhere") })).resolves.toMatchObject({ ok: true });
    await expect(prisma.eventCrewMember.findUniqueOrThrow({ where: { id: member.id } })).resolves.toMatchObject({ userId: crew.organiserId });
    await expect(verifyHours(staffFor(event), hours.id)).resolves.toMatchObject({ ok: false, error: "Another organiser must verify your hours." });
    await expect(issueContributorCertificate(staffFor(event), member.id)).resolves.toMatchObject({ ok: false });
    // With verified hours, the email no longer changes at all.
    const admin = await secondAdmin("follow");
    users.push(admin.id);
    await expect(verifyHours(staffFor(event, admin.id), hours.id)).resolves.toMatchObject({ ok: true });
    await expect(updateCrewMemberAsOrganiser(ctxFor(event), member.id, { name: "Me", email: crewEmail("again") })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("can't change") });
  });

  it("links only verified accounts, and mobile reaches a linked ticket only while the emails match", async () => {
    const event = await shiftsEvent();
    const email = crewEmail("unverified");
    const person = await prisma.user.create({ data: { name: "Unverified", email } });
    users.push(person.id);
    const { member } = await volunteer(event, { email });
    expect(member.userId).toBeNull();
    await expect(prisma.$transaction((tx) => linkCrewAccount(tx, person.id, email, event.id))).resolves.toBe(0);
    await prisma.eventCrewMember.update({ where: { id: member.id }, data: { userId: person.id } });
    await expect(ownCrewTicket(person.id, member.rsvpId)).resolves.toBeNull();
    await prisma.user.update({ where: { id: person.id }, data: { emailVerified: new Date() } });
    await expect(ownCrewTicket(person.id, member.rsvpId)).resolves.toMatchObject({ id: member.rsvpId });
    await prisma.eventCrewMember.update({ where: { id: member.id }, data: { email: crewEmail("moved") } });
    await expect(ownCrewTicket(person.id, member.rsvpId)).resolves.toBeNull();
  });

  it("guards attendance by state under the shift lock, and refuses it when shifts are off", async () => {
    const event = await shiftsEvent();
    const shift = await makeShift(event, { startIn: 5, graceMinutes: 15 });
    const { member, self } = await volunteer(event);
    await applyForShift(self, shift.id);
    const signup = await prisma.volunteerShiftSignup.findFirstOrThrow({ where: { crewMemberId: member.id } });
    const desk = { kind: "desk" as const, staff: staffFor(event) };
    const results = await Promise.all([checkInToShift(desk, signup.id), checkInToShift({ kind: "self", self }, signup.id)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    // A no-show is never written over a check-in, and the reverse.
    const ended = await prisma.volunteerShift.create({ data: { eventId: event.id, title: "Ended", startsAt: new Date(Date.now() - 300 * MINUTE), endsAt: new Date(Date.now() - 200 * MINUTE), signupDeadline: new Date(Date.now() - 300 * MINUTE) } });
    const other = await volunteer(event);
    const late = await prisma.volunteerShiftSignup.create({ data: { eventId: event.id, shiftId: ended.id, crewMemberId: other.member.id, status: "APPROVED" } });
    await expect(markNoShow(staffFor(event), late.id)).resolves.toMatchObject({ ok: true });
    await expect(markNoShow(staffFor(event), late.id)).resolves.toMatchObject({ ok: false });
    await prisma.event.update({ where: { id: event.id }, data: { volunteerShiftsEnabled: false } });
    await expect(markNoShow(staffFor(event), late.id)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("not open") });
  });

  it("refuses a shift edit that would give volunteers overlapping places", async () => {
    const event = await shiftsEvent();
    const morning = await makeShift(event, { startIn: 60, length: 60 });
    const noon = await makeShift(event, { startIn: 120, length: 60 });
    const [a, b] = [await volunteer(event), await volunteer(event)];
    for (const person of [a, b]) {
      await applyForShift(person.self, morning.id);
      await applyForShift(person.self, noon.id);
    }
    const form = { title: noon.title, zone: "", task: "", startsAt: new Date(noon.startsAt.getTime() - 30 * MINUTE).toISOString(), endsAt: noon.endsAt.toISOString(), signupDeadline: new Date(noon.startsAt.getTime() - 30 * MINUTE).toISOString(), capacity: 0, waitlistEnabled: true, requiresApproval: false, graceMinutes: 15 };
    await expect(updateShift(staffFor(event), noon.id, form)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("2 volunteers") });
    await expect(updateShift(staffFor(event), noon.id, { ...form, startsAt: new Date(noon.startsAt.getTime() + 30 * MINUTE).toISOString(), signupDeadline: noon.startsAt.toISOString() })).resolves.toMatchObject({ ok: true });
  });

  it("only lets hours start pending with the attendance's counted minutes", async () => {
    const event = await shiftsEvent();
    const { member } = await volunteer(event);
    const start = new Date(Date.now() - 300 * MINUTE);
    const shift = await prisma.volunteerShift.create({ data: { eventId: event.id, title: "Guarded", startsAt: start, endsAt: new Date(start.getTime() + 240 * MINUTE), signupDeadline: start } });
    const signup = await prisma.volunteerShiftSignup.create({ data: { eventId: event.id, shiftId: shift.id, crewMemberId: member.id, status: "APPROVED", attendance: "CHECKED_OUT", checkedInAt: start, checkedOutAt: new Date(start.getTime() + 90 * MINUTE), breakMinutes: 10 } });
    await expect(prisma.volunteerHours.create({ data: { eventId: event.id, signupId: signup.id, minutes: 600 } })).rejects.toThrow(/counted minutes/);
    await expect(prisma.volunteerHours.create({ data: { eventId: event.id, signupId: signup.id, minutes: 80, state: "VERIFIED" } })).rejects.toThrow(/counted minutes/);
    await expect(prisma.volunteerHours.create({ data: { eventId: event.id, signupId: signup.id, minutes: 80, version: 3 } })).rejects.toThrow(/counted minutes/);
    await expect(prisma.volunteerHours.create({ data: { eventId: event.id, signupId: signup.id, minutes: 80 } })).resolves.toMatchObject({ state: "PENDING" });
  });

  it("revokes a mentoring certificate whose evidence is gone, and replaces it on reissue", async () => {
    const event = await createCrewEvent({ registrationMode: RegistrationMode.TEAM });
    const mentor = await prisma.user.create({ data: { name: "Mentor", email: crewEmail("mentor"), emailVerified: new Date() } });
    users.push(mentor.id);
    await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: mentor.id, permissions: [EventPermission.MENTOR] } });
    const { member } = await volunteer(event, { email: mentor.email, kind: "MENTOR" });
    const team = await prisma.team.create({ data: { eventId: event.id, name: "Owls", nameKey: randomUUID(), status: "CONFIRMED", joinToken: randomUUID(), manageTokenHash: randomUUID() } });
    const assignment = await prisma.mentorTeamAssignment.create({ data: { eventId: event.id, mentorUserId: mentor.id, teamId: team.id, mode: "MANUAL", activatedAt: new Date() } });
    await expect(issueContributorCertificate(staffFor(event), member.id)).resolves.toMatchObject({ ok: true });
    const first = await prisma.contributorCertificate.findFirstOrThrow({ where: { crewMemberId: member.id } });
    // Still backed: a recheck keeps it; evidence gone: the download stops and a recheck revokes it.
    await expect(prisma.$transaction((tx) => recheckMentoringCertificatesLocked(tx, event.id, mentor.id))).resolves.toBe(0);
    await prisma.mentorTeamAssignment.delete({ where: { id: assignment.id } });
    await expect(loadContributorCertificate(first.token)).resolves.toBeNull();
    await expect(prisma.$transaction((tx) => recheckMentoringCertificatesLocked(tx, event.id, mentor.id))).resolves.toBe(1);
    // A stale live certificate is replaced, not a reason to refuse.
    await prisma.contributorCertificate.update({ where: { id: first.id }, data: { revokedAt: null, revokedReason: null } });
    await prisma.mentorTeamAssignment.create({ data: { eventId: event.id, mentorUserId: mentor.id, teamId: team.id, mode: "MANUAL", activatedAt: new Date() } });
    await prisma.contributorCertificate.update({ where: { id: first.id }, data: { minutes: 30 } });
    await expect(issueContributorCertificate(staffFor(event), member.id)).resolves.toMatchObject({ ok: true });
    await expect(prisma.contributorCertificate.findUniqueOrThrow({ where: { id: first.id } })).resolves.toMatchObject({ revokedReason: "evidence_changed" });
  });
});
