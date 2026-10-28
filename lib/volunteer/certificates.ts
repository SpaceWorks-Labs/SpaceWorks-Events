import "server-only";

import crypto from "node:crypto";
import { Prisma, type CrewKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { certificateImagesAreOwned } from "@/lib/certificateAssets";
import { certificateTemplateSchema, parseCertificateTemplate } from "@/lib/certificateTemplate";
import { enqueueVolunteerNotice } from "@/lib/outbox/volunteer";
import { revokeCertificatesLocked, verifiedMinutes } from "./hours";
import { hasMentoringEvidence } from "./mentoring";
import { CREW_KIND_LABELS, SECOND_PERSON, crewTicketLive, fail, isVolunteerSelf, lockCrewMember, type VolunteerResult, type VolunteerStaff } from "./shared";

/*
 * Contributor certificates (docs/VOLUNTEERS.md), after the Space Works
 * contribution proof: an owner or admin who is not the crew member issues
 * one; it snapshots the role, the verified minutes and the design, and is
 * revoked when hours change. It needs verified minutes above zero, or
 * mentoring evidence from the Mentor Desk (./mentoring.ts), which revokes it
 * when the MENTOR grant goes. A role or kind alone proves nothing.
 */

const ADMIN_ONLY = "Only organisation owners and admins can issue certificates.";

/** Whether a certificate's evidence still holds: the same verified minutes, or (with none) mentoring evidence. */
async function stillBacked(client: Prisma.TransactionClient | typeof prisma, eventId: string, member: { id: string; userId: string | null }, minutes: number) {
  return minutes > 0 ? (await verifiedMinutes(client, member.id)) === minutes : hasMentoringEvidence(client, eventId, member.userId);
}

export function generateCertificateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function isCertificateTokenShape(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

/** The role printed for {{role}}: "Volunteer · Registration desk", or the kind alone. */
export function contributorRole(member: { kind: CrewKind; role: string }) {
  const role = member.role.trim();
  return role ? `${CREW_KIND_LABELS[member.kind]} · ${role}`.slice(0, 120) : CREW_KIND_LABELS[member.kind];
}

export async function issueContributorCertificate(staff: VolunteerStaff, crewMemberId: string, now = new Date()): Promise<VolunteerResult<{ id: string }>> {
  if (!staff.isAdmin) return fail(ADMIN_ONLY);
  try {
    return await prisma.$transaction(async (tx): Promise<VolunteerResult<{ id: string }>> => {
      const event = await tx.event.findFirst({ where: { id: staff.eventId, organisationId: staff.organisationId }, select: { contributorCertificateTemplate: true } });
      if (!event) return fail("Event not found.");
      const member = await lockCrewMember(tx, staff.eventId, crewMemberId);
      if (!member || !crewTicketLive(member)) return fail("Crew member not found.");
      if (await isVolunteerSelf(tx, staff.userId, member)) return fail("Another organiser must issue your certificate.");
      const live = await tx.contributorCertificate.findFirst({ where: { crewMemberId: member.id, revokedAt: null }, select: { minutes: true } });
      if (live && (await stillBacked(tx, staff.eventId, member, live.minutes))) return fail("This crew member already has a certificate.");
      // A certificate whose evidence is gone (hours or mentoring changed) is replaced.
      if (live) await revokeCertificatesLocked(tx, member.id, "evidence_changed", now);
      const minutes = await verifiedMinutes(tx, member.id);
      // Verified hours, or mentoring evidence from the Mentor Desk (./mentoring.ts); never the kind alone.
      if (minutes <= 0 && !(await hasMentoringEvidence(tx, staff.eventId, member.userId))) return fail("Verify this volunteer's hours, or their mentoring, before issuing a certificate.");
      const template = parseCertificateTemplate(event.contributorCertificateTemplate);
      const certificate = await tx.contributorCertificate.create({
        data: {
          eventId: staff.eventId, crewMemberId: member.id, token: generateCertificateToken(), role: contributorRole(member), kind: member.kind, minutes,
          template: template ?? Prisma.DbNull, issuedAt: now, issuedByUserId: staff.userId,
        },
        select: { id: true },
      });
      await enqueueVolunteerNotice(tx, { to: member.email, organisationId: staff.organisationId, notice: "certificate", crewMemberId: member.id });
      return { ok: true, data: certificate };
    });
  } catch (error) {
    // Lost a race with another issue: the partial unique index keeps one live certificate.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return fail("This crew member already has a certificate.");
    throw error;
  }
}

export async function revokeContributorCertificate(staff: VolunteerStaff, crewMemberId: string): Promise<VolunteerResult> {
  if (!staff.isAdmin) return fail(ADMIN_ONLY);
  return prisma.$transaction(async (tx): Promise<VolunteerResult> => {
    const member = await lockCrewMember(tx, staff.eventId, crewMemberId);
    if (!member || !(await tx.event.count({ where: { id: staff.eventId, organisationId: staff.organisationId } }))) return fail("Crew member not found.");
    if (await isVolunteerSelf(tx, staff.userId, member)) return fail(SECOND_PERSON);
    return (await revokeCertificatesLocked(tx, member.id, "revoked_by_organiser")) > 0 ? { ok: true, data: undefined } : fail("There is no certificate to revoke.");
  });
}

/** Saves (or clears) the contributor certificate design. Owner/admin; images must be this organisation's uploads. */
export async function saveContributorCertificateTemplate(staff: VolunteerStaff, input: unknown): Promise<VolunteerResult> {
  if (!staff.isAdmin) return fail(ADMIN_ONLY);
  let template: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
  if (input != null) {
    const parsed = certificateTemplateSchema.safeParse(input);
    if (!parsed.success) return fail("Check the certificate layers.");
    if (!(await certificateImagesAreOwned(parsed.data, staff.organisationId))) return fail("Invalid certificate image.");
    template = parsed.data as Prisma.InputJsonValue;
  }
  const updated = await prisma.event.updateMany({ where: { id: staff.eventId, organisationId: staff.organisationId }, data: { contributorCertificateTemplate: template } });
  return updated.count === 1 ? { ok: true, data: undefined } : fail("Event not found.");
}

/**
 * A live certificate for download: not revoked, its crew ticket still
 * confirmed, and its minutes still the member's verified minutes (hours
 * changes revoke it anyway; this is the belt to that brace).
 */
export async function loadContributorCertificate(token: unknown) {
  if (!isCertificateTokenShape(token)) return null;
  const certificate = await prisma.contributorCertificate.findUnique({
    where: { token },
    select: {
      role: true, minutes: true, template: true, issuedAt: true, revokedAt: true, kind: true,
      crewMember: { select: { id: true, name: true, userId: true, eventId: true, rsvp: { select: { status: true } }, event: { select: { title: true, startDateTime: true, timezone: true, organisationId: true, organisation: { select: { name: true } } } } } },
    },
  });
  if (!certificate || certificate.revokedAt || !crewTicketLive(certificate.crewMember)) return null;
  if (!(await stillBacked(prisma, certificate.crewMember.eventId, certificate.crewMember, certificate.minutes))) return null;
  return certificate;
}
