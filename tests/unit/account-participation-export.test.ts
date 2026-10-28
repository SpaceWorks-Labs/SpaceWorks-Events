import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => new Map<string, { where: unknown; select: Record<string, unknown> }>());
vi.mock("@/lib/db", () => {
  const model = (name: string) => ({ findMany: async (args: { where: unknown; select: Record<string, unknown> }) => { calls.set(name, args); return []; } });
  return { prisma: new Proxy({}, { get: (_target, name: string) => model(name) }) };
});

import { buildParticipationExport, loadParticipationSource, type ParticipationSource } from "@/lib/accountDataExport/participation";

/*
 * The participation sections of the personal data export
 * (docs/SECURITY.md "Data privacy"): keyed on the user, allow-listed fields
 * only, no tokens, hashes, storage keys, payment references or other
 * people's details.
 */

const SECRETS = ["ticket-token-value", "certificate-token-value", "org/uploads/event-crew/secret-key.webp", "PAYREF-123", "hash-value", "manage-token-value", "other-person@example.test"];
const at = new Date("2030-01-01T10:00:00Z");
const event = { title: "Hack Day" };

/** Rows polluted with secret columns, as if a loader over-selected. */
const polluted = {
  crew: [{ name: "Ada", email: "ada@example.test", role: "Desk", kind: "VOLUNTEER", foodPreference: "Vegan", bio: "Hi", linkedinUrl: null, showOnPage: true, joinedViaLink: false, createdAt: at, photoUrl: SECRETS[2], event, rsvp: { checkInToken: SECRETS[0] } }],
  expenseClaims: [{ eventTitle: "Hack Day", kind: "PARTICIPANT", status: "APPROVED", category: "TRAVEL", description: "Train", amountMinor: BigInt(12345), approvedMinor: BigInt(10000), currency: "INR", payeeName: "Ada", payeeEmail: "ada@example.test", decisionNote: "", decidedAt: at, createdAt: at, policy: { name: "Travel" }, _count: { receipts: 2 }, decidedBy: { email: SECRETS[6] }, eligibilitySnapshot: { token: SECRETS[0] } }],
  volunteerSignups: [{ status: "APPROVED", attendance: "CHECKED_OUT", checkedInAt: at, checkedOutAt: at, breakMinutes: 5, createdAt: at, shift: { title: "Doors", zone: "A", task: "Scan", startsAt: at, endsAt: at, event }, hours: { minutes: 120, state: "VERIFIED" }, attendanceActorId: "staff-1" }],
  contributorCertificates: [{ role: "Desk", kind: "VOLUNTEER", minutes: 120, issuedAt: at, revokedAt: null, crewMember: { event }, token: SECRETS[1] }],
  mentorProfiles: [{ skills: ["ML"], bio: "Mentor", affiliation: "Acme Labs", availability: [], maxActiveTeams: 4, showOnPage: false, createdAt: at, event }],
  helpRequests: [{ summary: "Stuck", location: "Table 4", status: "RESOLVED", origin: "TEAM", rating: 5, createdAt: at, resolvedAt: at, cancelledAt: null, category: { label: "Code" }, event, claimedBy: { email: SECRETS[6] }, dedupKey: SECRETS[4] }],
  helpComments: [{ body: "Thanks", createdAt: at, request: { summary: "Stuck", event } }],
  officeHourBookings: [{ status: "BOOKED", cancelReason: null, createdAt: at, cancelledAt: null, team: { name: "Comets", manageTokenHash: SECRETS[5] }, slot: { startsAt: at, endsAt: at, location: "Room 2", event, mentor: { email: SECRETS[6] } } }],
  teamSeekerProfiles: [{ headline: "Designer", skills: ["UI"], visible: true, createdAt: at, rsvp: { event, checkInToken: SECRETS[0] } }],
  teamJoinRequests: [{ direction: "REQUEST", status: "PENDING", createdAt: at, team: { name: "Comets", event, joinToken: SECRETS[5] } }],
  prizePayouts: [{ awardName: "Best hack", projectTitle: "Robot", amountMinor: BigInt(500000), currency: "INR", paidAt: at, reversesId: null, event, reference: SECRETS[3], recipientName: "Comets", note: "bank" }],
} as unknown as ParticipationSource;

describe("participation export", () => {
  it("exports the user's own participation with allow-listed fields only", () => {
    const out = buildParticipationExport(polluted);
    const json = JSON.stringify(out);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
    expect(json).not.toMatch(/"(\w*[tT]oken\w*|\w*Hash\w*|reference|photoUrl|note|recipientName)":/);
    expect(out.crewPlaces[0]).toMatchObject({ event: "Hack Day", foodPreference: "Vegan", bio: "Hi", hasPhoto: true });
    expect(out.expenseClaims[0]).toMatchObject({ amount: "123.45", approvedAmount: "100.00", receipts: 2, policy: "Travel", decisionNote: null });
    expect(out.volunteerShifts[0]).toMatchObject({ shift: "Doors", hours: { minutes: 120, state: "VERIFIED" } });
    expect(out.contributorCertificates[0]).toEqual({ event: "Hack Day", role: "Desk", kind: "VOLUNTEER", minutes: 120, issuedAt: at.toISOString(), revokedAt: null });
    expect(out.mentorProfiles[0]).toMatchObject({ affiliation: "Acme Labs" });
    expect(out.helpRequests[0]).toMatchObject({ summary: "Stuck", category: "Code" });
    expect(out.helpComments[0]).toMatchObject({ comment: "Thanks" });
    expect(out.officeHourBookings[0]).toMatchObject({ team: "Comets", location: "Room 2" });
    expect(out.teamSeekerProfiles[0]).toMatchObject({ headline: "Designer" });
    expect(out.teamJoinRequests[0]).toMatchObject({ team: "Comets", direction: "REQUEST" });
    expect(out.prizePayouts[0]).toEqual({ event: "Hack Day", award: "Best hack", project: "Robot", currency: "INR", amount: "5000.00", reversal: false, paidAt: at.toISOString() });
  });

  it("reads only the user's rows and never selects a secret column", async () => {
    await loadParticipationSource("user_1");
    const where = (name: string) => JSON.stringify(calls.get(name)?.where);
    expect(where("expenseClaim")).toBe(JSON.stringify({ submittedByUserId: "user_1" }));
    expect(where("mentorProfile")).toBe(JSON.stringify({ userId: "user_1" }));
    expect(where("helpRequest")).toBe(JSON.stringify({ raisedByUserId: "user_1" }));
    expect(where("helpRequestComment")).toBe(JSON.stringify({ authorUserId: "user_1" }));
    expect(where("officeHourBooking")).toBe(JSON.stringify({ bookedByUserId: "user_1" }));
    for (const name of ["eventCrewMember", "volunteerShiftSignup", "contributorCertificate", "teamSeekerProfile", "teamJoinRequest", "prizePayout"]) expect(where(name)).toContain("user_1");
    expect(calls.size).toBe(11);
    const selects = JSON.stringify([...calls.values()].map((call) => call.select));
    expect(selects).not.toMatch(/"(token|checkInToken|joinToken|manageTokenHash|reference|note|recipientName|eligibilitySnapshot|storageKey|claimedByUserId|mentorUserId)"/);
  });
});
