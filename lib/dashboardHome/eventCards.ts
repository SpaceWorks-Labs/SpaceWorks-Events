import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { intervalCounts, nowAndNext } from "@/lib/dashboardHomeMetrics";
import { ARRIVAL_BUCKETS, ARRIVAL_BUCKET_MS, DAY_MS, LISTED, LIVE_LEAD_MS, SAMPLE_LIMIT } from "./constants";
import { countsFor, displayName, firstName, toEventRow, type EventForRow, type RsvpCounts } from "./rows";
import { teamUnitNoun } from "@/lib/teamCapacityDisplay";
import type { DashboardHome, HomeLiveEvent } from "./types";

/** The Next up card for one event. `canManage` must reflect the person's role in its organisation. */
export async function loadNextUp(event: EventForRow, counts: RsvpCounts, canManage: boolean, now: Date): Promise<NonNullable<DashboardHome["next"]>> {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const [signupsLastDay, recent] = await Promise.all([
    prisma.rSVP.count({ where: { eventId: event.id, createdAt: { gte: dayAgo } } }),
    // Named attendees only: anonymous guests are counted but not shown as avatars.
    prisma.rSVP.findMany({
      where: { eventId: event.id, status: "CONFIRMED", OR: [{ guestName: { not: null } }, { user: { name: { not: null } } }] },
      orderBy: { createdAt: "desc" },
      take: 4,
      select: { guestName: true, user: { select: { name: true } } },
    }),
  ]);
  return {
    ...toEventRow(event, counts, canManage),
    location: event.isOnline ? "Online" : event.location,
    startDateTime: event.startDateTime,
    timezone: event.timezone,
    confirmed: countsFor(counts, event.id).confirmed,
    // What fills capacity: attendees (never crew) or team units; crew are named beside them.
    placesUsed: counts.units.get(event.id) ?? 0,
    crew: counts.crew.get(event.id) ?? 0,
    capacity: event.capacity,
    capacityUnits: event.registrationMode === "TEAM" ? { used: counts.units.get(event.id) ?? 0, noun: teamUnitNoun(event.soloPolicy, event.capacity ?? 0) } : null,
    signupsLastDay,
    checkInHref: canManage ? `/dashboard/${event.organisation.slug}/event/${event.id}/check-in` : null,
    recentNames: recent.map((rsvp) => displayName(rsvp)).filter((name) => name !== "A guest").map(firstName),
    publicPath: event.status === "PUBLISHED" ? `/${event.organisation.slug}/${event.slug}` : null,
  };
}

/** Where to look for an event that is on now (two hours before start until it ends). */
export function liveEventWhere(base: Prisma.EventWhereInput, now: Date): Prisma.EventWhereInput {
  return { ...base, status: { in: LISTED }, startDateTime: { lte: new Date(now.getTime() + LIVE_LEAD_MS) }, endDateTime: { gte: now } };
}

/** Event-day panel data for one event. `canManage` must reflect the person's role in its organisation. */
export async function loadLiveEvent(event: EventForRow, canManage: boolean, now: Date): Promise<HomeLiveEvent> {
  const start = event.startDateTime;
  const arrivalsStart = new Date(Math.max(start.getTime() - ARRIVAL_BUCKET_MS * 2, Math.min(now.getTime(), event.endDateTime.getTime()) - ARRIVAL_BUCKET_MS * ARRIVAL_BUCKETS));
  const [confirmed, checkedIn, arrivalDates, door, sessions] = await Promise.all([
    prisma.rSVP.count({ where: { eventId: event.id, status: "CONFIRMED" } }),
    prisma.rSVP.count({ where: { eventId: event.id, checkedInAt: { not: null } } }),
    prisma.rSVP.findMany({ where: { eventId: event.id, checkedInAt: { gte: arrivalsStart } }, select: { checkedInAt: true }, take: SAMPLE_LIMIT }),
    prisma.rSVP.findMany({ where: { eventId: event.id, checkedInAt: { not: null } }, orderBy: { checkedInAt: "desc" }, take: 5, select: { id: true, checkedInAt: true, guestName: true, user: { select: { name: true } } } }),
    prisma.eventSession.findMany({ where: { eventId: event.id, visibility: { not: "DRAFT" } }, orderBy: { startDateTime: "asc" }, take: 100, select: { id: true, title: true, startDateTime: true, endDateTime: true, delayMinutes: true } }),
  ]);
  const arrivals = intervalCounts(arrivalDates.flatMap((rsvp) => (rsvp.checkedInAt ? [rsvp.checkedInAt] : [])), arrivalsStart, ARRIVAL_BUCKET_MS, ARRIVAL_BUCKETS);
  const stage = nowAndNext(sessions, now);
  const base = `/dashboard/${event.organisation.slug}/event/${event.id}`;
  return {
    id: event.id,
    title: event.title,
    href: canManage ? base : null,
    checkInHref: canManage ? `${base}/check-in` : null,
    scheduleHref: canManage ? `${base}/schedule` : null,
    timezone: event.timezone,
    location: event.isOnline ? "Online" : event.location,
    startDateTime: start,
    endDateTime: event.endDateTime,
    started: start <= now,
    confirmed,
    checkedIn,
    arrivals: arrivals.map((count, index) => ({ label: new Date(arrivalsStart.getTime() + index * ARRIVAL_BUCKET_MS), count })),
    door: door.map((rsvp) => ({ key: rsvp.id, who: displayName(rsvp), at: rsvp.checkedInAt as Date })),
    onStage: {
      now: stage.now ? { title: stage.now.title, start: stage.now.start, end: stage.now.end } : null,
      next: stage.next ? { title: stage.next.title, start: stage.next.start } : null,
    },
  };
}
