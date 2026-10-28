import "server-only";

import { RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { loadVolunteerShifts } from "@/lib/eventDashboard/volunteerShifts";
import { loadMyShifts } from "@/lib/volunteer/ticketView";
import { myShiftsDtoSchema, volunteerRosterDtoSchema } from "@/lib/mobile/schemas";
import type { MobileEventContext } from "@/lib/mobile/organiser";

/*
 * Volunteer shifts on mobile (docs/VOLUNTEERS.md, docs/MOBILE_API.md). A crew
 * member reaches their own crew ticket by its registration id when the ticket
 * belongs to their account or their crew record is linked to it; every action
 * then runs the crew ticket's own Server Action. Organisers read the same
 * roster as Guests → Crew → Shifts.
 */

/**
 * The caller's own confirmed crew ticket, or null (NOT_FOUND): a ticket on
 * their account, or a crew record linked to their account whose email is
 * still that account's verified email. The link opens nothing else.
 */
export async function ownCrewTicket(userId: string, rsvpId: string) {
  if (!rsvpId || rsvpId.length > 128) return null;
  const rsvp = await prisma.rSVP.findFirst({
    where: { id: rsvpId, isCrew: true, status: RsvpStatus.CONFIRMED, OR: [{ userId }, { crewMember: { userId } }] },
    select: { id: true, isCrew: true, status: true, checkInToken: true, userId: true, crewMember: { select: { email: true, user: { select: { email: true, emailVerified: true } } } } },
  });
  if (!rsvp) return null;
  const linked = rsvp.crewMember?.user;
  const verifiedLink = Boolean(linked?.emailVerified && linked.email?.trim().toLowerCase() === rsvp.crewMember?.email);
  if (rsvp.userId !== userId && !verifiedLink) return null;
  return { id: rsvp.id, isCrew: rsvp.isCrew, status: rsvp.status, checkInToken: rsvp.checkInToken };
}

/** The caller's shifts on that ticket; null when the event has no volunteer shifts on. */
export async function loadMyShiftsDto(rsvp: { id: string; isCrew: boolean; status: RsvpStatus }, baseUrl: string) {
  const view = await loadMyShifts(rsvp);
  if (!view) return null;
  const { certificatePath, ...rest } = view;
  return myShiftsDtoSchema.parse({ ...rest, certificateUrl: certificatePath ? `${baseUrl}${certificatePath}` : null });
}

export async function loadRosterDto(event: MobileEventContext, userId: string) {
  const data = await loadVolunteerShifts({ userId, event: { id: event.event.id }, organisation: event.organisation, permissions: { isAdmin: event.permissions.manageFinance } });
  return volunteerRosterDtoSchema.parse({
    enabled: data.enabled,
    isAdmin: data.isAdmin,
    timeZone: data.timeZone,
    shifts: data.shifts,
    contributors: data.contributors,
  });
}
