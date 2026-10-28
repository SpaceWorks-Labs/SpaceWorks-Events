import { EventPermission } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { acceptEventCollaboratorInviteToken } from "@/lib/inviteAcceptance";
import { hashEventCollaboratorToken } from "@/lib/eventCollaboratorToken";
import { joinCrewWithLink, setCrewJoinLink } from "@/lib/core/crew";
import { decideVolunteerSignup, manageContributorCertificate, reviewVolunteerHours, saveVolunteerShift, setVolunteerShifts } from "@/app/actions/volunteer-shifts";
import { myShiftAction } from "@/app/actions/my-shifts";
import { crew, crewEmail, ctxFor, setUpCrewOrgs, tearDownCrewOrgs } from "./helpers/crew";
import { makeShift, shiftsEvent, tearDownUsers, volunteer, workedHours } from "./helpers/volunteers";

/* Who may act on shifts (docs/VOLUNTEERS.md): the crew rule, owner/admin for hours and certificates, tickets for volunteers. Kind never grants anything. */

const users: string[] = [];
const scope = (eventId: string) => ({ organisationSlug: crew.orgSlug, eventId });
const shiftForm = () => {
  const start = new Date(Date.now() + 3_600_000);
  return { title: "Doors", zone: "", task: "", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString(), signupDeadline: start.toISOString(), capacity: 3, waitlistEnabled: true, requiresApproval: true, graceMinutes: 10 };
};

async function account(label: string) {
  const user = await prisma.user.create({ data: { name: label, email: crewEmail(label), emailVerified: new Date() } });
  users.push(user.id);
  return user;
}

describe.sequential("volunteer shift permissions", () => {
  beforeAll(() => setUpCrewOrgs("vperms"));
  afterAll(async () => {
    identity.id = "";
    await flushWebhookEmits();
    await tearDownUsers(users);
    await tearDownCrewOrgs();
  });

  it("never lets a crew kind grant authority: an ORGANISER-kind crew member with an account gets no organiser action", async () => {
    const event = await shiftsEvent();
    const person = await account("kind-organiser");
    const { member } = await volunteer(event, { email: person.email, kind: "ORGANISER" });
    expect(member).toMatchObject({ kind: "ORGANISER", userId: person.id });
    identity.id = person.id;
    await expect(saveVolunteerShift({ ...scope(event.id), shift: shiftForm() })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("permission") });
    await expect(setVolunteerShifts({ ...scope(event.id), enabled: false })).resolves.toMatchObject({ ok: false });
    const hours = await workedHours(event, member.id, 30);
    await expect(reviewVolunteerHours({ ...scope(event.id), hoursId: hours.id, action: "verify" })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("permission") });
  });

  it("lets a MANAGE_REGISTRATIONS co-organiser run shifts but not verify hours or issue certificates", async () => {
    const event = await shiftsEvent();
    const helper = await account("co-organiser");
    await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: helper.id, permissions: [EventPermission.MANAGE_REGISTRATIONS] } });
    const checker = await account("check-in-only");
    await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: checker.id, permissions: [EventPermission.CHECK_IN] } });
    identity.id = checker.id;
    await expect(saveVolunteerShift({ ...scope(event.id), shift: shiftForm() })).resolves.toMatchObject({ ok: false });
    identity.id = helper.id;
    const saved = await saveVolunteerShift({ ...scope(event.id), shift: shiftForm() });
    expect(saved).toMatchObject({ ok: true });
    const { member } = await volunteer(event);
    const hours = await workedHours(event, member.id, 30);
    await expect(reviewVolunteerHours({ ...scope(event.id), hoursId: hours.id, action: "verify" })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("owners and admins") });
    await expect(manageContributorCertificate({ ...scope(event.id), crewMemberId: member.id, action: "issue" })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("owners and admins") });
    await expect(prisma.auditEvent.count({ where: { action: "VOLUNTEER_SHIFT_CREATED", actorUserId: helper.id } })).resolves.toBe(1);
  });

  it("treats another organisation's ids as not found", async () => {
    const event = await shiftsEvent();
    const { member, self } = await volunteer(event);
    const shift = await makeShift(event, { requiresApproval: true });
    await myShiftAction({ ticketToken: member.rsvp.checkInToken, action: "apply", id: shift.id });
    const signup = await prisma.volunteerShiftSignup.findFirstOrThrow({ where: { crewMemberId: self.crewMemberId } });
    identity.id = crew.otherOrganiserId;
    await expect(decideVolunteerSignup({ ...scope(event.id), signupId: signup.id, decision: "approve" })).resolves.toMatchObject({ ok: false });
    await expect(decideVolunteerSignup({ organisationSlug: `crew-other-vperms-${crew.suffix}`, eventId: event.id, signupId: signup.id, decision: "approve" })).resolves.toMatchObject({ ok: false });
    await expect(prisma.volunteerShiftSignup.findUniqueOrThrow({ where: { id: signup.id } })).resolves.toMatchObject({ status: "APPLIED" });
    identity.id = crew.organiserId;
    await expect(decideVolunteerSignup({ ...scope(event.id), signupId: signup.id, decision: "approve" })).resolves.toMatchObject({ ok: true });
  });

  it("acts for a volunteer only through their own crew ticket, signed in when the ticket belongs to an account", async () => {
    const event = await shiftsEvent();
    const shift = await makeShift(event);
    const person = await account("ticket-owner");
    const { member } = await volunteer(event);
    await prisma.rSVP.update({ where: { id: member.rsvpId }, data: { userId: person.id } });
    identity.id = "";
    await expect(myShiftAction({ ticketToken: member.rsvp.checkInToken, action: "apply", id: shift.id })).resolves.toMatchObject({ ok: false });
    identity.id = crew.organiserId;
    await expect(myShiftAction({ ticketToken: member.rsvp.checkInToken, action: "apply", id: shift.id })).resolves.toMatchObject({ ok: false });
    identity.id = person.id;
    await expect(myShiftAction({ ticketToken: member.rsvp.checkInToken, action: "apply", id: shift.id })).resolves.toMatchObject({ ok: true, data: { status: "APPROVED" } });
    await expect(myShiftAction({ ticketToken: "a".repeat(43), action: "apply", id: shift.id })).resolves.toMatchObject({ ok: false });
    await prisma.event.update({ where: { id: event.id }, data: { volunteerShiftsEnabled: false } });
    const signup = await prisma.volunteerShiftSignup.findFirstOrThrow({ where: { crewMemberId: member.id } });
    await expect(myShiftAction({ ticketToken: member.rsvp.checkInToken, action: "withdraw", id: signup.id })).resolves.toMatchObject({ ok: false });
  });

  it("gives link sign-ups the link's kind and links crew to accounts on invitation acceptance", async () => {
    const event = await shiftsEvent();
    const link = await setCrewJoinLink(ctxFor(event), "create", "MENTOR");
    if (!link.ok || !link.data) throw new Error("no link");
    const email = crewEmail("mentor");
    await expect(joinCrewWithLink(link.data.token, { name: "Mentor Person", email })).resolves.toMatchObject({ ok: true });
    const joined = await prisma.eventCrewMember.findFirstOrThrow({ where: { eventId: event.id, email } });
    expect(joined).toMatchObject({ kind: "MENTOR", joinedViaLink: true, userId: null });
    const person = await prisma.user.create({ data: { name: "Mentor", email } });
    users.push(person.id);
    const token = `invite-${crew.suffix}`;
    await prisma.eventCollaboratorInvite.create({ data: { eventId: event.id, email, permissions: [EventPermission.CHECK_IN], tokenHash: hashEventCollaboratorToken(token), expiresAt: new Date(Date.now() + 3_600_000), createdByUserId: crew.organiserId } });
    await expect(acceptEventCollaboratorInviteToken(token, { id: person.id, email })).resolves.toMatchObject({ ok: true });
    await expect(prisma.eventCrewMember.findUniqueOrThrow({ where: { id: joined.id } })).resolves.toMatchObject({ userId: person.id, kind: "MENTOR" });
  });
});
