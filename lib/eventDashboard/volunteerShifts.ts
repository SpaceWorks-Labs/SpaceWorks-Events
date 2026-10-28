import "server-only";

import { cache } from "react";
import { CrewKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseCertificateTemplate, type CertificateTemplate } from "@/lib/certificateTemplate";
import { formatDate } from "@/lib/format/datetime";
import { hasNonShiftEvidence } from "@/lib/volunteer/certificates";
import type { EventDashboardContext } from "@/lib/eventDashboard/context";

/*
 * Guests → Crew → Shifts data (docs/VOLUNTEERS.md). Callers must have checked
 * `ctx.permissions.canManageCrew`. Verification and certificates are shown to
 * everyone with the crew rule but only owners and admins (and never the
 * volunteer themself) can use them; the actions re-check. Hours are never
 * money: a volunteer's expense claims are listed beside their shifts only.
 */

export type DashboardSignup = {
  id: string; crewMemberId: string; name: string; kind: CrewKind; status: string; attendance: string; queuedAt: string;
  checkedInAt: string | null; checkedOutAt: string | null; breakMinutes: number;
  hours: { id: string; minutes: number; state: string } | null; isViewer: boolean;
};

export type DashboardShift = {
  id: string; title: string; zone: string; task: string; startsAt: string; endsAt: string; signupDeadline: string;
  capacity: number; waitlistEnabled: boolean; requiresApproval: boolean; graceMinutes: number; closed: boolean;
  approved: number; signups: DashboardSignup[];
};

export type DashboardContributor = {
  crewMemberId: string; name: string; kind: CrewKind; role: string; verifiedMinutes: number; pendingHours: number;
  certificate: { issuedAt: string } | null; eligible: boolean; isViewer: boolean;
  claims: { open: number; total: number };
};

export type DashboardVolunteerShifts = {
  enabled: boolean;
  isAdmin: boolean;
  timeZone: string;
  shifts: DashboardShift[];
  contributors: DashboardContributor[];
  template: CertificateTemplate | null;
  eventTitle: string;
  eventDateLabel: string;
  organisationName: string;
};

export const loadVolunteerShifts = cache(async (ctx: EventDashboardContext): Promise<DashboardVolunteerShifts> => {
  const eventId = ctx.event.id;
  const [event, viewer, shifts, crew, hours, certificates, claims] = await Promise.all([
    prisma.event.findFirstOrThrow({ where: { id: eventId, organisationId: ctx.organisation.id }, select: { volunteerShiftsEnabled: true, contributorCertificateTemplate: true, timezone: true, title: true, startDateTime: true } }),
    prisma.user.findUnique({ where: { id: ctx.userId }, select: { email: true } }),
    prisma.volunteerShift.findMany({
      where: { eventId },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: 200,
      include: { signups: { orderBy: [{ queuedAt: "asc" }, { id: "asc" }], include: { hours: { select: { id: true, minutes: true, state: true } } } } },
    }),
    prisma.eventCrewMember.findMany({ where: { eventId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], take: 500, select: { id: true, name: true, email: true, kind: true, role: true, userId: true, rsvpId: true } }),
    prisma.volunteerHours.findMany({ where: { eventId, signup: { attendance: "CHECKED_OUT" } }, select: { minutes: true, state: true, signup: { select: { crewMemberId: true } } } }),
    prisma.contributorCertificate.findMany({ where: { eventId, revokedAt: null }, select: { crewMemberId: true, issuedAt: true } }),
    prisma.expenseClaim.findMany({ where: { eventId, rsvp: { isCrew: true } }, select: { rsvpId: true, status: true } }),
  ]);
  const viewerEmail = viewer?.email?.trim().toLowerCase();
  const byId = new Map(crew.map((member) => [member.id, member]));
  const isViewer = (member: { userId: string | null; email: string } | undefined) => Boolean(member && (member.userId === ctx.userId || member.email === viewerEmail));
  const verified = new Map<string, number>();
  const pending = new Map<string, number>();
  for (const row of hours) {
    const target = row.state === "PENDING" ? pending : verified;
    target.set(row.signup.crewMemberId, (target.get(row.signup.crewMemberId) ?? 0) + (row.state === "PENDING" ? 1 : row.minutes));
  }
  const issued = new Map(certificates.map((row) => [row.crewMemberId, row.issuedAt.toISOString()]));
  const claimCounts = new Map<string, { open: number; total: number }>();
  for (const claim of claims) {
    if (!claim.rsvpId) continue;
    const entry = claimCounts.get(claim.rsvpId) ?? { open: 0, total: 0 };
    entry.total += 1;
    if (claim.status === "SUBMITTED" || claim.status === "APPROVED") entry.open += 1;
    claimCounts.set(claim.rsvpId, entry);
  }
  return {
    enabled: event.volunteerShiftsEnabled,
    isAdmin: ctx.permissions.isAdmin,
    timeZone: event.timezone,
    template: parseCertificateTemplate(event.contributorCertificateTemplate),
    eventTitle: event.title,
    eventDateLabel: formatDate(event.startDateTime, event.timezone),
    organisationName: ctx.organisation.name,
    shifts: shifts.map((shift) => ({
      id: shift.id, title: shift.title, zone: shift.zone, task: shift.task,
      startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString(), signupDeadline: shift.signupDeadline.toISOString(),
      capacity: shift.capacity, waitlistEnabled: shift.waitlistEnabled, requiresApproval: shift.requiresApproval, graceMinutes: shift.graceMinutes, closed: shift.closed,
      approved: shift.signups.filter((signup) => signup.status === "APPROVED").length,
      signups: shift.signups.map((signup) => {
        const member = byId.get(signup.crewMemberId);
        return {
          id: signup.id, crewMemberId: signup.crewMemberId, name: member?.name ?? "Crew member", kind: member?.kind ?? CrewKind.VOLUNTEER,
          status: signup.status, attendance: signup.attendance, queuedAt: signup.queuedAt.toISOString(),
          checkedInAt: signup.checkedInAt?.toISOString() ?? null, checkedOutAt: signup.checkedOutAt?.toISOString() ?? null, breakMinutes: signup.breakMinutes,
          hours: signup.hours, isViewer: isViewer(member),
        };
      }),
    })),
    contributors: crew.map((member) => {
      const minutes = verified.get(member.id) ?? 0;
      return {
        crewMemberId: member.id, name: member.name, kind: member.kind, role: member.role, verifiedMinutes: minutes, pendingHours: pending.get(member.id) ?? 0,
        certificate: issued.has(member.id) ? { issuedAt: issued.get(member.id)! } : null,
        eligible: minutes > 0 || hasNonShiftEvidence(member.kind),
        isViewer: isViewer(member),
        claims: claimCounts.get(member.rsvpId) ?? { open: 0, total: 0 },
      };
    }),
  };
});
