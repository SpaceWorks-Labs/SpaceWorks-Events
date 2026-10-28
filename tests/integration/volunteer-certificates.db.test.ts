import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { adjustHours, verifyHours } from "@/lib/volunteer/hours";
import { issueContributorCertificate, loadContributorCertificate, revokeContributorCertificate, saveContributorCertificateTemplate } from "@/lib/volunteer/certificates";
import { loadMyShifts } from "@/lib/volunteer/ticketView";
import { crew, setUpCrewOrgs, tearDownCrewOrgs } from "./helpers/crew";
import { notices, secondAdmin, shiftsEvent, staffFor, tearDownUsers, volunteer, workedHours } from "./helpers/volunteers";

/* Contributor certificates (docs/VOLUNTEERS.md): verified minutes, one live certificate, revocation when hours change. */

const users: string[] = [];

describe.sequential("contributor certificates", () => {
  beforeAll(() => setUpCrewOrgs("vcerts"));
  afterAll(async () => {
    await flushWebhookEmits();
    await tearDownUsers(users);
    await tearDownCrewOrgs();
  });

  it("needs verified minutes above zero; pending hours and a role label prove nothing", async () => {
    const event = await shiftsEvent();
    const staff = staffFor(event);
    const { member } = await volunteer(event, { role: "Registration desk" });
    await expect(issueContributorCertificate(staff, member.id)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Verify") });
    const hours = await workedHours(event, member.id, 150);
    await expect(issueContributorCertificate(staff, member.id)).resolves.toMatchObject({ ok: false });
    await verifyHours(staff, hours.id);
    await expect(issueContributorCertificate(staffFor(event, crew.organiserId, false), member.id)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("owners and admins") });
    const issued = await issueContributorCertificate(staff, member.id);
    expect(issued.ok).toBe(true);
    const certificate = await prisma.contributorCertificate.findFirstOrThrow({ where: { crewMemberId: member.id } });
    expect(certificate).toMatchObject({ role: "Volunteer · Registration desk", kind: "VOLUNTEER", minutes: 150, revokedAt: null, issuedByUserId: crew.organiserId });
    expect(certificate.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(notices(member.id, "certificate")).resolves.toBe(1);
    await expect(issueContributorCertificate(staff, member.id)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("already") });
    await expect(loadContributorCertificate(certificate.token)).resolves.toMatchObject({ minutes: 150, role: "Volunteer · Registration desk" });
    const view = await loadMyShifts({ id: member.rsvpId, isCrew: true, status: "CONFIRMED" });
    expect(view).toMatchObject({ verifiedMinutes: 150, certificatePath: `/api/crew/certificate/${certificate.token}` });
  });

  it("revokes an issued certificate when hours change, and keeps one live certificate per person", async () => {
    const event = await shiftsEvent();
    const staff = staffFor(event);
    const { member } = await volunteer(event);
    const hours = await workedHours(event, member.id, 120);
    await verifyHours(staff, hours.id);
    await issueContributorCertificate(staff, member.id);
    const first = await prisma.contributorCertificate.findFirstOrThrow({ where: { crewMemberId: member.id } });
    await expect(adjustHours(staff, hours.id, 90, "Took a long lunch")).resolves.toMatchObject({ ok: true, data: { minutes: 90, revokedCertificate: true } });
    await expect(prisma.contributorCertificate.findUniqueOrThrow({ where: { id: first.id } })).resolves.toMatchObject({ revokedReason: "hours_changed" });
    await expect(loadContributorCertificate(first.token)).resolves.toBeNull();
    await expect(issueContributorCertificate(staff, member.id)).resolves.toMatchObject({ ok: true });
    await expect(prisma.contributorCertificate.findFirstOrThrow({ where: { crewMemberId: member.id, revokedAt: null } })).resolves.toMatchObject({ minutes: 90 });
    // The partial unique index is the final word on one live certificate.
    await expect(prisma.contributorCertificate.create({ data: { eventId: event.id, crewMemberId: member.id, token: "x".repeat(43), role: "Volunteer", kind: "VOLUNTEER", minutes: 90 } })).rejects.toThrow();
    await expect(revokeContributorCertificate(staff, member.id)).resolves.toMatchObject({ ok: true });
    await expect(revokeContributorCertificate(staff, member.id)).resolves.toMatchObject({ ok: false });
  });

  it("lets organisers issue mentors a certificate without hours (the Mentor Desk hook), but never to themselves", async () => {
    const event = await shiftsEvent();
    const staff = staffFor(event);
    const { member: mentor } = await volunteer(event, { kind: "MENTOR" });
    await expect(issueContributorCertificate(staff, mentor.id)).resolves.toMatchObject({ ok: true });
    const certificate = await prisma.contributorCertificate.findFirstOrThrow({ where: { crewMemberId: mentor.id } });
    expect(certificate).toMatchObject({ kind: "MENTOR", minutes: 0, role: "Mentor · Logistics" });
    await expect(loadContributorCertificate(certificate.token)).resolves.toMatchObject({ kind: "MENTOR" });
    const admin = await secondAdmin("certs");
    users.push(admin.id);
    const { member: self } = await volunteer(event, { email: admin.email, kind: "MENTOR" });
    await expect(issueContributorCertificate(staffFor(event, admin.id), self.id)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Another organiser") });
  });

  it("accepts only this organisation's certificate images for the design", async () => {
    const event = await shiftsEvent();
    const staff = staffFor(event);
    const foreign = { version: 2, backgroundKey: `organisations/${crew.otherOrganisationId}/certificate-backgrounds/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.webp`, elements: [] };
    await expect(saveContributorCertificateTemplate(staff, foreign)).resolves.toMatchObject({ ok: false, error: "Invalid certificate image." });
    await expect(saveContributorCertificateTemplate(staffFor(event, crew.organiserId, false), null)).resolves.toMatchObject({ ok: false });
    await expect(saveContributorCertificateTemplate(staff, null)).resolves.toEqual({ ok: true, data: undefined });
    // Another organisation's staff cannot reach this event.
    await expect(saveContributorCertificateTemplate({ ...staff, organisationId: crew.otherOrganisationId }, null)).resolves.toMatchObject({ ok: false, error: "Event not found." });
  });
});
