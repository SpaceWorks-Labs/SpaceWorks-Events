import "server-only";

import { Prisma, RsvpStatus } from "@prisma/client";
import { getCheckInDetails, getRegistrationDetails } from "@/lib/checkInDetails";
import { prisma } from "@/lib/db";
import { SPONSOR_LIMIT_MAX, type IdCardPrintSettings } from "@/lib/idCardPrint";
import { attendeePhotoUrl, managedImageUrl } from "./imageUrl";
import type { BadgeStatusFilter } from "./filters";
import type { IdCardAttendee } from "./types";

/*
 * Database side of badges: the event's branding and saved design, and the
 * attendees to print. Callers check access first (lib/badge/access.ts).
 */

export const badgeEventSelect = {
  id: true,
  title: true,
  slug: true,
  organisationId: true,
  organisation: { select: { name: true, slug: true, logoUrl: true } },
  page: { select: { logoUrl: true, accentColor: true } },
  badgeDesign: { select: { settings: true, updatedAt: true } },
  sponsors: {
    where: { visibility: "PUBLISHED", logoUrl: { not: null } },
    orderBy: [{ tier: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    take: SPONSOR_LIMIT_MAX,
    select: { logoUrl: true },
  },
} satisfies Prisma.EventSelect;

export type BadgeEvent = Prisma.EventGetPayload<{ select: typeof badgeEventSelect; }>;

export function loadBadgeEvent(eventId: string) {
  return prisma.event.findUnique({ where: { id: eventId }, select: badgeEventSelect });
}

export type BadgeDesignState = { settings: IdCardPrintSettings; saved: boolean; updatedAt: string | null; };

export function badgeStatusWhere(filter: BadgeStatusFilter): Prisma.RSVPWhereInput {
  if (filter === "checked-in") return { checkedInAt: { not: null } };
  // Event crew (docs/CREW.md) and everyone else, for printing crew badges separately.
  if (filter === "crew") return { isCrew: true };
  if (filter === "attendees") return { status: RsvpStatus.CONFIRMED, isCrew: false };
  if (filter === "not-checked-in") return { status: RsvpStatus.CONFIRMED, checkedInAt: null };
  if (filter === "all") return { status: { in: [RsvpStatus.CONFIRMED, RsvpStatus.WAITLISTED, RsvpStatus.PENDING_APPROVAL] } };
  return { status: RsvpStatus.CONFIRMED };
}

export const badgeRsvpInclude = {
  user: { select: { id: true, name: true, email: true, profileImageUrl: true, image: true } },
  answers: { include: { field: { select: { key: true, label: true } } } },
  team: { select: { name: true } },
  crewMember: { select: { role: true, photoUrl: true, foodPreference: true } },
} satisfies Prisma.RSVPInclude;

type BadgeRsvp = Prisma.RSVPGetPayload<{ include: typeof badgeRsvpInclude; }>;

/**
 * One badge. A crew ticket (docs/CREW.md) prints "Crew" and its role in the
 * team slot, and its crew photo when it is a crew upload of this event's
 * organisation (storage key only, never a remote URL).
 */
export function badgeAttendeeFor(rsvp: BadgeRsvp, organisationId?: string): IdCardAttendee {
  const crew = rsvp.isCrew ? rsvp.crewMember : null;
  const crewPhoto = crew?.photoUrl && organisationId ? managedImageUrl(crew.photoUrl, { kind: "organisation", organisationId, category: "event-crew" }) : null;
  return {
    rsvpId: rsvp.id,
    displayName: rsvp.user?.name?.trim() || rsvp.guestName?.trim() || rsvp.user?.email || rsvp.guestEmail || "Guest",
    email: rsvp.user?.email ?? rsvp.guestEmail,
    checkInQrToken: rsvp.checkInToken,
    checkInDetails: getCheckInDetails(rsvp.answers, crew),
    registrationDetails: getRegistrationDetails(rsvp.answers),
    photoUrl: crewPhoto ?? attendeePhotoUrl(rsvp.user),
    teamName: rsvp.isCrew ? (crew?.role.trim() ? `Crew · ${crew.role.trim()}` : "Crew") : (rsvp.team?.name ?? null),
  };
}

/** One RSVP of this event (never another event's), for a single badge. */
export async function loadBadgeAttendee(eventId: string, rsvpId: string) {
  const rsvp = await prisma.rSVP.findFirst({ where: { id: rsvpId, eventId }, include: { ...badgeRsvpInclude, event: { select: { organisationId: true } } } });
  return rsvp ? badgeAttendeeFor(rsvp, rsvp.event?.organisationId) : null;
}

export function countBadgeAttendees(eventId: string, filter: BadgeStatusFilter) {
  return prisma.rSVP.count({ where: { eventId, ...badgeStatusWhere(filter) } });
}

/** Attendees in a stable order, read in batches so a large event never sits in memory at once. */
export async function* badgeAttendees(eventId: string, filter: BadgeStatusFilter, limit: number, batchSize = 100) {
  let cursor: string | undefined;
  let yielded = 0;
  while (yielded < limit) {
    const rows = await prisma.rSVP.findMany({
      where: { eventId, ...badgeStatusWhere(filter) },
      orderBy: { id: "asc" },
      take: Math.min(batchSize, limit - yielded),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { ...badgeRsvpInclude, event: { select: { organisationId: true } } },
    });
    if (rows.length === 0) return;
    for (const row of rows) {
      yield badgeAttendeeFor(row, row.event?.organisationId);
      yielded += 1;
    }
    cursor = rows.at(-1)!.id;
  }
}

export { badgeBrandingFor, badgeDesignFor } from "@/lib/badge/presentation";
