import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { buildParticipationExport, loadParticipationSource } from "@/lib/accountDataExport/participation";
import { addCrew, crew, crewEmail, setUpCrewOrgs, tearDownCrewOrgs } from "./helpers/crew";
import { makeShift, shiftsEvent, tearDownUsers } from "./helpers/volunteers";

/*
 * The participation sections of the personal data export
 * (docs/SECURITY.md "Data privacy") hold the account's own rows only: its
 * crew place, the claims it filed, its volunteer shifts and certificate, its
 * mentor profile, its team seeker profile, never anyone else's.
 */

const users: string[] = [];
beforeAll(() => setUpCrewOrgs("export"));
afterAll(async () => {
  await tearDownUsers(users);
  await tearDownCrewOrgs();
});

async function account(label: string) {
  const user = await prisma.user.create({ data: { name: label, email: crewEmail(label), emailVerified: new Date() } });
  users.push(user.id);
  return user;
}

describe.sequential("participation in the personal data export", () => {
  it("exports only the account's own crew, claims, shifts, certificates, mentor and seeker rows", async () => {
    const event = await shiftsEvent();
    const [ada, bo] = [await account("ada"), await account("bo")];
    const mine = await addCrew(event, { email: ada.email, bio: "Hello" });
    const theirs = await addCrew(event, { email: bo.email });
    // Linked to their accounts, as a verified account with that email is.
    expect([mine.userId, theirs.userId]).toEqual([ada.id, bo.id]);
    await prisma.eventCrewMember.update({ where: { id: mine.id }, data: { photoUrl: `/api/uploads/${crew.organisationId}/event-crew/secret.webp` } });

    const shift = await makeShift(event, { title: "Doors" });
    for (const member of [mine, theirs]) await prisma.volunteerShiftSignup.create({ data: { eventId: event.id, shiftId: shift.id, crewMemberId: member.id, status: "APPROVED" } });
    await prisma.contributorCertificate.create({ data: { eventId: event.id, crewMemberId: mine.id, token: `cert-${crew.suffix}`, role: "Logistics", kind: "VOLUNTEER", minutes: 90 } });
    const claim = (userId: string, description: string) => prisma.expenseClaim.create({ data: {
      organisationId: crew.organisationId, eventId: event.id, eventTitle: event.title, kind: "CREW", submittedByUserId: userId, payeeName: "Payee", payeeEmail: "payee@example.test",
      category: "TRAVEL", description, amountMinor: BigInt(2500), currency: "INR",
    } });
    await claim(ada.id, "My train");
    await claim(bo.id, "Their taxi");
    await prisma.mentorProfile.create({ data: { eventId: event.id, userId: ada.id, affiliation: "Acme Labs", skills: ["ML"] } });
    await prisma.mentorProfile.create({ data: { eventId: event.id, userId: bo.id, affiliation: "Other Co" } });

    const out = buildParticipationExport(await loadParticipationSource(ada.id));
    expect(out.crewPlaces).toEqual([expect.objectContaining({ email: ada.email, bio: "Hello", foodPreference: "Vegan", hasPhoto: true })]);
    expect(out.volunteerShifts).toEqual([expect.objectContaining({ shift: "Doors", status: "APPROVED" })]);
    expect(out.contributorCertificates).toEqual([expect.objectContaining({ minutes: 90, revokedAt: null })]);
    expect(out.expenseClaims).toEqual([expect.objectContaining({ description: "My train", amount: "25.00" })]);
    expect(out.mentorProfiles).toEqual([expect.objectContaining({ affiliation: "Acme Labs", skills: ["ML"] })]);
    const json = JSON.stringify(out);
    for (const leak of [bo.email, "Their taxi", "Other Co", `cert-${crew.suffix}`, "secret.webp", mine.rsvp.checkInToken]) expect(json).not.toContain(leak);
  });

  it("exports the account's own team seeker profile and join requests", async () => {
    const event = await shiftsEvent();
    const ada = await account("seeker");
    const rsvp = await prisma.rSVP.create({ data: { eventId: event.id, userId: ada.id, attendeeKey: `user:${ada.id}`, status: "CONFIRMED" } });
    await prisma.teamSeekerProfile.create({ data: { rsvpId: rsvp.id, headline: "Designer", skills: ["UI"] } });
    const leader = await prisma.rSVP.create({ data: { eventId: event.id, guestEmail: crewEmail("lead"), guestName: "Lead", attendeeKey: `guest:${crewEmail("lead")}`, status: "CONFIRMED" } });
    const team = await prisma.team.create({ data: { eventId: event.id, name: "Comets", nameKey: `comets-${crew.suffix}`, status: "CONFIRMED", joinToken: `join-${crew.suffix}`, manageTokenHash: `manage-${crew.suffix}`, leaderRsvpId: leader.id } });
    await prisma.teamJoinRequest.create({ data: { teamId: team.id, rsvpId: rsvp.id, direction: "REQUEST" } });
    const out = buildParticipationExport(await loadParticipationSource(ada.id));
    expect(out.teamSeekerProfiles).toEqual([expect.objectContaining({ headline: "Designer", skills: ["UI"] })]);
    expect(out.teamJoinRequests).toEqual([expect.objectContaining({ team: "Comets", direction: "REQUEST", status: "PENDING" })]);
    for (const leak of [team.joinToken, team.manageTokenHash, rsvp.checkInToken]) expect(JSON.stringify(out)).not.toContain(leak);
  });
});
