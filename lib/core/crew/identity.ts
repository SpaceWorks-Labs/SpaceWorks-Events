import "server-only";

import type { Prisma } from "@prisma/client";
import { crewPersonIds, lockPersons } from "@/lib/personLock";
import { hasApprovedShiftBetween, lockCrewMembers } from "@/lib/volunteer/shared";
import { DeskError } from "@/lib/core/mentorDesk/shared";

export const CREW_LINK_CONFLICT = "This account cannot be linked because an approved volunteer shift overlaps a booked office hour. Cancel the shift place or reschedule the booking first.";

/** After the Event lock, before any grant, RSVP or crew lock: lock every current and proposed person together. */
export async function lockCrewLinkPersons(tx: Prisma.TransactionClient, eventId: string, memberIds: readonly string[], userIds: readonly string[]) {
  await lockPersons(tx, [...await crewPersonIds(tx, eventId, memberIds), ...userIds]);
}

/** Under the person and crew locks: check existing duties as if the proposed identity link already existed. */
export async function requireCrewLinkAvailable(tx: Prisma.TransactionClient, eventId: string, crewMemberId: string, userId: string) {
  const slots = await tx.officeHourSlot.findMany({
    where: { eventId, mentorUserId: userId, cancelledAt: null, bookings: { some: { status: "BOOKED" } } },
    select: { startsAt: true, endsAt: true },
  });
  for (const slot of slots) {
    if (await hasApprovedShiftBetween(tx, eventId, { userId, crewMemberId }, slot.startsAt, slot.endsAt)) throw new DeskError(CREW_LINK_CONFLICT);
  }
}

/** Transaction only. Event locks precede all person/crew locks, also when linking several events. */
export async function linkCrewAccount(tx: Prisma.TransactionClient, userId: string, email: string | null | undefined, eventId?: string) {
  const normalised = email?.trim().toLowerCase();
  if (!normalised) return 0;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } });
  if (!user?.emailVerified || user.email?.trim().toLowerCase() !== normalised) return 0;
  const where = { email: normalised, userId: null, ...(eventId ? { eventId } : {}) };
  const events = (await tx.eventCrewMember.findMany({ where, select: { eventId: true } })).map((row) => row.eventId);
  const ids = [...new Set(eventId ? [eventId] : events)].sort();
  if (ids.length === 0) return 0;
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
  const members = await tx.eventCrewMember.findMany({ where: { ...where, eventId: { in: ids } }, select: { id: true, eventId: true } });
  const people = (await Promise.all(ids.map((id) => crewPersonIds(tx, id, members.filter((m) => m.eventId === id).map((m) => m.id))))).flat();
  await lockPersons(tx, [...people, userId]);
  // Crew ids are globally unique: lock the whole set in one id-ordered statement.
  const memberIds = members.map((m) => m.id).sort();
  if (memberIds.length === 0) return 0;
  await tx.$queryRaw`SELECT "id" FROM "EventCrewMember" WHERE "id" = ANY(${memberIds}::text[]) ORDER BY "id" FOR UPDATE`;
  for (const member of members) await requireCrewLinkAvailable(tx, member.eventId, member.id, userId);
  return (await tx.eventCrewMember.updateMany({ where: { ...where, id: { in: memberIds } }, data: { userId } })).count;
}

/** The other identity direction, including unverified mentors whose crew place has no userId. Transaction only. */
export async function linkMentorCrew(tx: Prisma.TransactionClient, eventId: string, userId: string, crewMemberId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
  await lockCrewLinkPersons(tx, eventId, [crewMemberId], [userId]);
  await lockCrewMembers(tx, eventId, [crewMemberId]);
  const member = await tx.eventCrewMember.findFirst({ where: { id: crewMemberId, eventId }, select: { id: true } });
  if (!member) return 0;
  await requireCrewLinkAvailable(tx, eventId, crewMemberId, userId);
  return (await tx.mentorProfile.updateMany({ where: { eventId, userId, crewMemberId: null }, data: { crewMemberId } })).count;
}
