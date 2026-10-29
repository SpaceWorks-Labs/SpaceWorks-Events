import "server-only";

/** Mentor Desk result shapes, refusal copy and the transaction wrapper (docs/MENTOR_DESK.md). */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export type DeskResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

export const ok = <T>(data: T): { ok: true; data: T } => ({ ok: true, data });
export const okEmpty = (): { ok: true; data: undefined } => ({ ok: true, data: undefined });
export const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Refusal copy, ported from the Space Works ProgrammeError messages. */
export const COPY = {
  notFound: "Not found.",
  invalid: "Check the details and try again.",
  disabled: "The Mentor Desk is off for this event.",
  offShift: "You are outside your mentoring availability.",
  notMentor: "You are not a mentor on this event.",
  notEligible: "This request needs another mentor.",
  busy: "Finish or release the current request first.",
  limit: "This team already has an open request in this category.",
  expired: "This help request expired.",
  leaseLost: "This help claim expired. Refresh the queue.",
  stale: "This was changed by someone else. Refresh and try again.",
  closed: "This request is closed.",
  reasonRequired: "Explain why the request is reopening.",
  category: "Choose an available help category.",
  full: "This mentor is at capacity.",
  conflict: "Choose an eligible mentor.",
  slotClosed: "This slot is closed.",
  bookingConflict: "The mentor is unavailable.",
  teamOverlap: "Your team has an overlapping booking.",
  slotStarted: "Ask an organiser to cancel a started slot.",
  slotFull: "This slot is full.",
  activeBookings: "Reschedule booked office hours before changing availability.",
  roundLocked: "A started round cannot change its form or policy.",
  roundWindow: "Choose a round window inside the event.",
  roundLive: "Close the current round first.",
  roundClosed: "This round has closed.",
  roundOutside: "The round is outside its scheduled window.",
  alreadySubmitted: "This team has already been checked in.",
  teamBusy: "Another visit is in progress.",
  ownTeam: "You cannot visit your own team.",
  conflictVisit: "This visit needs a permitted conflict exception.",
  freshEyes: "Choose a team you have not visited.",
  visitLease: "This visit lease expired or moved to another mentor.",
  visitRequired: "Complete a visit before nominating this team.",
  awayNomination: "An away visit cannot nominate a team.",
  alreadyNominated: "You already nominated this team in this round.",
  formChanged: "The round form changed; review it again.",
  answers: "Check the visit answers.",
  teamOnly: "Only teams can book office hours.",
} as const;

/** A refusal raised inside a transaction; rolls it back and becomes `fail(message)`. */
export class DeskError extends Error {}

export function refuse(message: string): never {
  throw new DeskError(message);
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Runs `body` in one transaction. A DeskError becomes its message; a unique
 * violation (the database's last word on races) becomes `onConflict`.
 */
export async function inTransaction<T>(body: (tx: Prisma.TransactionClient) => Promise<T>, onConflict: string = COPY.stale): Promise<DeskResult<T>> {
  try {
    return ok(await prisma.$transaction(body, { timeout: 15_000 }));
  } catch (error) {
    if (error instanceof DeskError) return fail(error.message);
    if (isUniqueViolation(error)) return fail(onConflict);
    throw error;
  }
}

/** Row locks, always taken in this order inside a command: event, then team, then the row. */
export async function lockEvent(tx: Prisma.TransactionClient, eventId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
}

/**
 * The Event FOR KEY SHARE, for commands that only need it to come first: it
 * waits for (and holds off) lockEvent's FOR UPDATE, but not other key-share
 * holders. It is the lock a new row referencing the Event takes anyway, taken
 * up front so the order stays Event -> person -> grant (docs/MENTOR_DESK.md).
 */
export async function shareEvent(tx: Prisma.TransactionClient, eventId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR KEY SHARE`;
}

/** Before grants, rounds and RSVP/team locks: help inserts reference Event. */
export const lockHelpEvent = shareEvent;

export async function lockTeam(tx: Prisma.TransactionClient, teamId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${teamId} FOR UPDATE`;
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/** The optimistic-concurrency check every command makes (check_version). */
export function checkVersion(row: { version: number }, expected: unknown) {
  if (typeof expected !== "number" || row.version !== expected) refuse(COPY.stale);
}
