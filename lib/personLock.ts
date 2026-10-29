import "server-only";

import type { Prisma } from "@prisma/client";

/*
 * The person lock (docs/MENTOR_DESK.md "Lock order", docs/VOLUNTEERS.md "Locks"):
 * the User row of the person a schedule decision is about, FOR NO KEY UPDATE,
 * so a mentor's booked office hours and their approved volunteer shifts are
 * decided one at a time. It sits after the Event lock (where a path takes
 * one) and before any grant, crew-member, shift or slot lock; several people
 * are locked together, in id order, in one statement. NO KEY UPDATE leaves
 * rows that only reference the user (audit, history) free to insert.
 *
 * A crew place belongs to a person through either link: its own `userId`, or
 * a mentor profile's `crewMemberId` (a mentor's crew place whose account link
 * is still missing). The links can change until the crew row is locked, so a
 * volunteer command locks the people it read, then the crew rows, then checks
 * nobody new appeared; if someone did, it rolls back and runs again.
 */

/** Locks these people's User rows in id order. */
export async function lockPersons(tx: Prisma.TransactionClient, userIds: readonly string[]) {
  const ids = [...new Set(userIds)].sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR NO KEY UPDATE`;
}

/** The accounts behind these crew places of the event, through either link, sorted. */
export async function crewPersonIds(tx: Prisma.TransactionClient, eventId: string, crewMemberIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(crewMemberIds)];
  if (ids.length === 0) return [];
  const [members, profiles] = await Promise.all([
    tx.eventCrewMember.findMany({ where: { id: { in: ids }, eventId, userId: { not: null } }, select: { userId: true } }),
    tx.mentorProfile.findMany({ where: { eventId, crewMemberId: { in: ids } }, select: { userId: true } }),
  ]);
  return [...new Set([...members.map((row) => row.userId!), ...profiles.map((row) => row.userId)])].sort();
}

/** Locks the people behind these crew places (read without locks) and returns who was locked. */
export async function lockCrewPersons(tx: Prisma.TransactionClient, eventId: string, crewMemberIds: readonly string[]) {
  const people = await crewPersonIds(tx, eventId, crewMemberIds);
  await lockPersons(tx, people);
  return people;
}

/** Thrown when a crew place gained a person the transaction had not locked. */
export class PersonsChanged extends Error {}

/** Under the crew row locks (the links are now fixed): every person behind these places must be among `locked`. */
export async function requirePersonsLocked(tx: Prisma.TransactionClient, eventId: string, crewMemberIds: readonly string[], locked: readonly string[]) {
  const people = await crewPersonIds(tx, eventId, crewMemberIds);
  if (people.some((id) => !locked.includes(id))) throw new PersonsChanged();
}

const ATTEMPTS = 3;

/** Runs `transaction` again when it rolled back with PersonsChanged; `onGiveUp` after the last attempt. */
export async function retryWhenPersonsChange<T>(transaction: () => Promise<T>, onGiveUp: T): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await transaction();
    } catch (error) {
      if (!(error instanceof PersonsChanged)) throw error;
      if (attempt >= ATTEMPTS) return onGiveUp;
    }
  }
}
