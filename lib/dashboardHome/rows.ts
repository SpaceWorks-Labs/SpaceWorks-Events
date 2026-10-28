import "server-only";

import type { Prisma, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getAccentTokens } from "@/lib/theme/accent";
import { eventFillStatus } from "@/lib/dashboardHomeMetrics";
import { teamUnitShortNoun } from "@/lib/teamCapacityDisplay";
import type { HomeEventRow } from "./types";

export function displayName(rsvp: { guestName: string | null; user: { name: string | null } | null }) {
  return rsvp.user?.name?.trim() || rsvp.guestName?.trim() || "A guest";
}

export function firstName(name: string) {
  return name === "A guest" ? name : name.split(/\s+/)[0];
}

function accentOf(value: string | null | undefined) {
  return getAccentTokens(value, "light")["--yy-accent"];
}

type CountKey = { eventId?: string | null; eventInstanceId?: string | null; status: RsvpStatus; _count: { _all: number } };

function tally(groups: CountKey[], key: "eventId" | "eventInstanceId") {
  const map = new Map<string, { confirmed: number; waitlisted: number; pending: number }>();
  for (const group of groups) {
    const id = group[key];
    if (!id) continue;
    const entry = map.get(id) ?? { confirmed: 0, waitlisted: 0, pending: 0 };
    if (group.status === "CONFIRMED") entry.confirmed += group._count._all;
    if (group.status === "WAITLISTED") entry.waitlisted += group._count._all;
    if (group.status === "PENDING_APPROVAL") entry.pending += group._count._all;
    map.set(id, entry);
  }
  return map;
}

export const eventSelect = {
  id: true,
  organisationId: true,
  title: true,
  slug: true,
  startDateTime: true,
  endDateTime: true,
  timezone: true,
  location: true,
  isOnline: true,
  capacity: true,
  registrationMode: true,
  soloPolicy: true,
  status: true,
  organisation: { select: { slug: true, name: true } },
  page: { select: { accentColor: true } },
} satisfies Prisma.EventSelect;

export type EventForRow = Prisma.EventGetPayload<{ select: typeof eventSelect }>;

/** `units` is what fills capacity (attendees, or team units); `crew` counts crew tickets (docs/CREW.md), which never fill it. */
export type RsvpCounts = { event: Map<string, CountTriple>; instance: Map<string, CountTriple>; units: Map<string, number>; crew: Map<string, number> };
type CountTriple = { confirmed: number; waitlisted: number; pending: number };
const EMPTY_COUNTS: CountTriple = { confirmed: 0, waitlisted: 0, pending: 0 };

/**
 * Confirmed / waitlisted / pending counts for the listed events and series
 * dates, plus the places used against capacity per event: confirmed people
 * minus crew (docs/CREW.md) and those in teams, plus confirmed teams
 * (docs/TEAMS.md).
 */
export async function loadRsvpCounts(eventIds: string[], instanceIds: string[]): Promise<RsvpCounts> {
  const uniqueEvents = [...new Set(eventIds)];
  const [eventGroups, instanceGroups, teamedGroups, teamGroups, crewGroups] = await Promise.all([
    uniqueEvents.length ? prisma.rSVP.groupBy({ by: ["eventId", "status"], where: { eventId: { in: uniqueEvents } }, _count: { _all: true } }) : Promise.resolve([]),
    instanceIds.length ? prisma.rSVP.groupBy({ by: ["eventInstanceId", "status"], where: { eventInstanceId: { in: instanceIds } }, _count: { _all: true } }) : Promise.resolve([]),
    uniqueEvents.length ? prisma.rSVP.groupBy({ by: ["eventId"], where: { eventId: { in: uniqueEvents }, status: "CONFIRMED", teamId: { not: null } }, _count: { _all: true } }) : Promise.resolve([]),
    uniqueEvents.length ? prisma.team.groupBy({ by: ["eventId"], where: { eventId: { in: uniqueEvents }, status: "CONFIRMED" }, _count: { _all: true } }) : Promise.resolve([]),
    uniqueEvents.length ? prisma.rSVP.groupBy({ by: ["eventId"], where: { eventId: { in: uniqueEvents }, isCrew: true }, _count: { _all: true } }) : Promise.resolve([]),
  ]);
  const event = tally(eventGroups, "eventId");
  const teamed = new Map(teamedGroups.map((group) => [group.eventId as string, group._count._all]));
  const teams = new Map(teamGroups.map((group) => [group.eventId, group._count._all]));
  const crew = new Map(crewGroups.map((group) => [group.eventId as string, group._count._all]));
  const units = new Map(uniqueEvents.map((id) => [id, (event.get(id)?.confirmed ?? 0) - (crew.get(id) ?? 0) - (teamed.get(id) ?? 0) + (teams.get(id) ?? 0)]));
  return { event, instance: tally(instanceGroups, "eventInstanceId"), units, crew };
}

/** What fills `capacity`: units on a TEAM event, attendees (never crew) otherwise. */
function teamUnits(event: EventForRow, counts: RsvpCounts): { used: number; noun: string } {
  return { used: counts.units.get(event.id) ?? 0, noun: event.registrationMode === "TEAM" ? teamUnitShortNoun(event.soloPolicy) : "going" };
}

export function countsFor(counts: RsvpCounts, eventId: string): CountTriple {
  return counts.event.get(eventId) ?? EMPTY_COUNTS;
}

/**
 * One event row. `canManage` must reflect the person's role in the event's
 * organisation: without it there is no management link and pending
 * approvals are not revealed.
 */
export function toEventRow(event: EventForRow, counts: RsvpCounts, canManage: boolean): HomeEventRow {
  const all = countsFor(counts, event.id);
  const tallies = canManage ? all : { ...all, pending: 0 };
  const units = teamUnits(event, counts);
  const draft = event.status === "DRAFT";
  return {
    key: `event-${event.id}`,
    href: canManage ? `/dashboard/${event.organisation.slug}/event/${event.id}` : null,
    title: event.title,
    organisationName: event.organisation.name,
    dateBlock: { start: event.startDateTime, timezone: event.timezone },
    meta: event.isOnline ? "Online" : event.location || "Venue to be confirmed",
    accent: accentOf(event.page?.accentColor),
    isSeries: false,
    isDraft: draft,
    status: draft ? { label: "Finish & publish", tone: "warning" } : eventFillStatus(tallies, event.capacity, units),
    fill: !draft && event.capacity ? { filled: units.used, total: event.capacity } : null,
  };
}

export const instanceSelect = {
  id: true,
  startDateTime: true,
  series: { select: { id: true, organisationId: true, title: true, timezone: true, capacity: true, organisation: { select: { slug: true, name: true } } } },
} satisfies Prisma.EventInstanceSelect;

export type InstanceForRow = Prisma.EventInstanceGetPayload<{ select: typeof instanceSelect }>;

export function toInstanceRow(instance: InstanceForRow, counts: RsvpCounts, canManage: boolean): HomeEventRow {
  const all = counts.instance.get(instance.id) ?? EMPTY_COUNTS;
  const tallies = canManage ? all : { ...all, pending: 0 };
  return {
    key: `instance-${instance.id}`,
    href: canManage ? `/dashboard/${instance.series.organisation.slug}/series/${instance.series.id}` : null,
    title: instance.series.title,
    organisationName: instance.series.organisation.name,
    dateBlock: { start: instance.startDateTime, timezone: instance.series.timezone },
    meta: "Series date",
    accent: accentOf(null),
    isSeries: true,
    isDraft: false,
    status: eventFillStatus(tallies, instance.series.capacity),
    fill: instance.series.capacity ? { filled: tallies.confirmed, total: instance.series.capacity } : null,
  };
}
