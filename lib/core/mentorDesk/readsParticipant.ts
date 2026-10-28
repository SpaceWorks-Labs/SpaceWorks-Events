import "server-only";

/*
 * What participants see: their own requests (and the comments on them), the
 * categories, mentors who chose to appear on the event page (name, bio and
 * skills only; never affiliation or email), and bookable office hours.
 * Reads never mutate.
 */

import { HelpRequestStatus, OfficeHourBookingStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { helpDeadline, parseAvailability, coversInterval } from "@/lib/mentorDesk/rules";
import { safeTimeZone } from "@/lib/timeZone";
import type { ParticipantContext } from "./access";

/** Mentors listed publicly (MentorProfile.showOnPage) on an event with the desk on. */
export async function loadPublicMentors(eventId: string) {
  const rows = await prisma.mentorProfile.findMany({
    where: { eventId, showOnPage: true, event: { mentorDeskEnabled: true }, user: { eventCollaborations: { some: { eventId, permissions: { has: "MENTOR" } } } } },
    select: { userId: true, bio: true, skills: true, user: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return rows.map((r) => ({ id: r.userId, name: r.user.name?.trim() || "Mentor", bio: r.bio, skills: r.skills }));
}

export async function loadParticipantDesk(p: ParticipantContext, now = new Date()) {
  const event = await prisma.event.findFirst({ where: { id: p.eventId, organisationId: p.organisationId, mentorDeskEnabled: true }, select: { id: true, timezone: true, endDateTime: true } });
  if (!event) return null;
  const scope = p.teamId ? { teamId: p.teamId } : { rsvpId: p.kind === "account" ? p.rsvpId : "" };
  const [categories, requests, mentors, slots, bookings] = await Promise.all([
    prisma.helpCategory.findMany({ where: { eventId: event.id, active: true }, orderBy: { position: "asc" }, select: { key: true, label: true, contactNote: true } }),
    prisma.helpRequest.findMany({
      where: { eventId: event.id, ...scope },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, version: true, status: true, summary: true, location: true, expiresAt: true, createdAt: true, rating: true, category: { select: { label: true } }, comments: { orderBy: { createdAt: "asc" }, take: 50, select: { id: true, origin: true, body: true, createdAt: true } } },
    }),
    loadPublicMentors(event.id),
    p.teamId
      ? prisma.officeHourSlot.findMany({
        where: { eventId: event.id, cancelledAt: null, startsAt: { gt: now }, bookingDeadline: { gt: now } },
        orderBy: { startsAt: "asc" },
        take: 100,
        select: { id: true, version: true, startsAt: true, endsAt: true, location: true, capacity: true, mentor: { select: { name: true, mentorProfiles: { where: { eventId: event.id }, select: { availability: true } } } }, _count: { select: { bookings: { where: { status: OfficeHourBookingStatus.BOOKED } } } } },
      })
      : Promise.resolve([]),
    p.teamId
      ? prisma.officeHourBooking.findMany({ where: { eventId: event.id, teamId: p.teamId, status: OfficeHourBookingStatus.BOOKED }, select: { id: true, slotId: true, slot: { select: { startsAt: true, endsAt: true, location: true, mentor: { select: { name: true } } } } }, orderBy: { slot: { startsAt: "asc" } } })
      : Promise.resolve([]),
  ]);
  const booked = new Set(bookings.map((b) => b.slotId));
  return {
    timezone: safeTimeZone(event.timezone),
    isTeam: Boolean(p.teamId),
    categories,
    requests: requests.map((r) => ({
      id: r.id, version: r.version, status: r.status, category: r.category.label, summary: r.summary, location: r.location, rating: r.rating,
      createdAt: r.createdAt.toISOString(), deadline: helpDeadline(r.expiresAt, event.endDateTime).toISOString(),
      open: r.status === HelpRequestStatus.OPEN || r.status === HelpRequestStatus.CLAIMED,
      comments: r.comments.map((c) => ({ id: c.id, origin: c.origin, body: c.body, createdAt: c.createdAt.toISOString() })),
    })),
    mentors,
    slots: slots
      .filter((s) => !booked.has(s.id) && s._count.bookings < s.capacity && coversInterval(parseAvailability(s.mentor.mentorProfiles[0]?.availability), s.startsAt, s.endsAt))
      .map((s) => ({ id: s.id, version: s.version, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), location: s.location, mentorName: s.mentor.name?.trim() || "Mentor", placesLeft: s.capacity - s._count.bookings })),
    bookings: bookings.map((b) => ({ id: b.id, startsAt: b.slot.startsAt.toISOString(), endsAt: b.slot.endsAt.toISOString(), location: b.slot.location, mentorName: b.slot.mentor.name?.trim() || "Mentor", started: b.slot.startsAt <= now })),
  };
}

export type ParticipantDeskView = NonNullable<Awaited<ReturnType<typeof loadParticipantDesk>>>;
