import "server-only";

import { RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { verifiedMinutes } from "./hours";
import { placesLeft } from "./math";
import { crewTicketLive, type VolunteerSelf } from "./shared";

/*
 * "My shifts" on a crew ticket (docs/VOLUNTEERS.md). The crew ticket link is
 * the capability, as for crew expense claims; an account-tied ticket also
 * needs that account signed in. Volunteers see and change only their own
 * sign-ups, never other volunteers.
 */

const TOKEN = /^[A-Za-z0-9_-]{8,256}$/;

/** The crew member behind a crew ticket, when shifts are on and the ticket still works. */
export async function resolveVolunteerSelf(ticketToken: unknown, sessionUserId: string | null | undefined): Promise<VolunteerSelf | null> {
  if (typeof ticketToken !== "string" || !TOKEN.test(ticketToken)) return null;
  const rsvp = await prisma.rSVP.findUnique({
    where: { checkInToken: ticketToken },
    select: { isCrew: true, status: true, userId: true, crewMember: { select: { id: true, eventId: true } }, event: { select: { volunteerShiftsEnabled: true, status: true } } },
  });
  if (!rsvp?.isCrew || rsvp.status !== RsvpStatus.CONFIRMED || !rsvp.crewMember || !rsvp.event?.volunteerShiftsEnabled || rsvp.event.status === "CANCELLED") return null;
  if (rsvp.userId && rsvp.userId !== sessionUserId) return null;
  return { eventId: rsvp.crewMember.eventId, crewMemberId: rsvp.crewMember.id };
}

export type MyShift = {
  id: string; title: string; zone: string; task: string; startsAt: string; endsAt: string; signupDeadline: string;
  graceMinutes: number; requiresApproval: boolean; open: boolean; placesLeft: number | null;
  signup: null | { id: string; status: string; attendance: string; checkedInAt: string | null; checkedOutAt: string | null; minutes: number | null; hoursState: string | null };
};

/** Null unless this is a confirmed crew ticket of an event with shifts on. */
export async function loadMyShifts(rsvp: { id: string; isCrew: boolean; status: RsvpStatus }, now = new Date()) {
  if (!rsvp.isCrew || rsvp.status !== RsvpStatus.CONFIRMED) return null;
  const member = await prisma.eventCrewMember.findUnique({
    where: { rsvpId: rsvp.id },
    select: { id: true, eventId: true, rsvp: { select: { status: true } }, event: { select: { volunteerShiftsEnabled: true, status: true, timezone: true } } },
  });
  if (!member || !crewTicketLive(member) || !member.event.volunteerShiftsEnabled || member.event.status === "CANCELLED") return null;
  const [shifts, certificate, verified] = await Promise.all([
    prisma.volunteerShift.findMany({
      where: { eventId: member.eventId, OR: [{ closed: false, endsAt: { gt: now } }, { signups: { some: { crewMemberId: member.id } } }] },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: 200,
      include: {
        _count: { select: { signups: { where: { status: "APPROVED" } } } },
        signups: { where: { crewMemberId: member.id }, select: { id: true, status: true, attendance: true, checkedInAt: true, checkedOutAt: true, hours: { select: { minutes: true, state: true } } } },
      },
    }),
    prisma.contributorCertificate.findFirst({ where: { crewMemberId: member.id, revokedAt: null }, select: { token: true } }),
    verifiedMinutes(prisma, member.id),
  ]);
  const list: MyShift[] = shifts.map((shift) => {
    const mine = shift.signups[0];
    return {
      id: shift.id, title: shift.title, zone: shift.zone, task: shift.task,
      startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString(), signupDeadline: shift.signupDeadline.toISOString(),
      graceMinutes: shift.graceMinutes, requiresApproval: shift.requiresApproval,
      open: !shift.closed && now < shift.signupDeadline && now < shift.startsAt,
      placesLeft: placesLeft(shift.capacity, shift._count.signups),
      signup: mine
        ? { id: mine.id, status: mine.status, attendance: mine.attendance, checkedInAt: mine.checkedInAt?.toISOString() ?? null, checkedOutAt: mine.checkedOutAt?.toISOString() ?? null, minutes: mine.hours?.minutes ?? null, hoursState: mine.hours?.state ?? null }
        : null,
    };
  });
  return {
    timeZone: member.event.timezone,
    shifts: list,
    verifiedMinutes: verified,
    certificatePath: certificate ? `/api/crew/certificate/${certificate.token}` : null,
  };
}

export type MyShiftsView = NonNullable<Awaited<ReturnType<typeof loadMyShifts>>>;
