import "server-only";

import { CrewKind, Prisma, RsvpStatus } from "@prisma/client";
import { z } from "zod";
import { MAX_GRACE_MINUTES, MAX_SHIFT_MINUTES } from "./math";

/*
 * Shared parts of the volunteer cores (docs/VOLUNTEERS.md). Callers authorise
 * first: organiser functions take a VolunteerStaff resolved with the crew rule
 * (MANAGE_REGISTRATIONS) and, for verification and certificates, owner/admin;
 * self functions take the crew member resolved from their own crew ticket.
 * Crew kind never decides what anyone may do.
 */

export type VolunteerResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
export const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** An organiser acting on one event: `isAdmin` is organisation owner/admin. */
export type VolunteerStaff = { organisationId: string; eventId: string; userId: string; isAdmin: boolean };

/** A crew member acting on their own sign-ups, resolved from their crew ticket. */
export type VolunteerSelf = { eventId: string; crewMemberId: string };

export const CREW_KIND_LABELS: Record<CrewKind, string> = {
  ORGANISER: "Organiser",
  VOLUNTEER: "Volunteer",
  MENTOR: "Mentor",
  JUDGE: "Judge",
};

export const crewKindSchema = z.nativeEnum(CrewKind);

export const NOT_FOUND = "Shift not found.";
export const SIGNUP_NOT_FOUND = "Sign-up not found.";
export const SHIFTS_OFF = "Volunteer shifts are not open for this event.";
export const SECOND_PERSON = "Another organiser must verify your hours.";

const MINUTE = 60_000;
const isoDate = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const shiftInputSchema = z
  .object({
    title: z.string().trim().min(1, "Enter a shift title.").max(120),
    zone: z.string().trim().max(100).default(""),
    task: z.string().trim().max(200).default(""),
    startsAt: isoDate,
    endsAt: isoDate,
    signupDeadline: isoDate,
    capacity: z.number().int().min(0).max(10_000),
    waitlistEnabled: z.boolean(),
    requiresApproval: z.boolean(),
    graceMinutes: z.number().int().min(0).max(MAX_GRACE_MINUTES),
  })
  .strict()
  .refine((v) => v.endsAt > v.startsAt, { message: "The shift must end after it starts.", path: ["endsAt"] })
  .refine((v) => v.endsAt.getTime() - v.startsAt.getTime() <= MAX_SHIFT_MINUTES * MINUTE, { message: "A shift can be up to 12 hours. Split longer duties into several shifts.", path: ["endsAt"] })
  .refine((v) => v.signupDeadline <= v.startsAt, { message: "Sign-ups must close by the time the shift starts.", path: ["signupDeadline"] });

export type ShiftInput = z.infer<typeof shiftInputSchema>;

export const reasonSchema = z.string().trim().min(1, "Give a reason.").max(500);

/** Locks one shift of the event (the capacity lock for its places). */
export async function lockShift(tx: Prisma.TransactionClient, eventId: string, shiftId: string) {
  await tx.$queryRaw`SELECT "id" FROM "VolunteerShift" WHERE "id" = ${shiftId} AND "eventId" = ${eventId} FOR UPDATE`;
  return tx.volunteerShift.findFirst({ where: { id: shiftId, eventId } });
}

/**
 * Locks one crew member (the per-person lock for overlapping duties, one
 * active check-in, hours and certificates). Always taken after the shift lock.
 */
export async function lockCrewMember(tx: Prisma.TransactionClient, eventId: string, crewMemberId: string) {
  await tx.$queryRaw`SELECT "id" FROM "EventCrewMember" WHERE "id" = ${crewMemberId} AND "eventId" = ${eventId} FOR UPDATE`;
  return tx.eventCrewMember.findFirst({
    where: { id: crewMemberId, eventId },
    select: { id: true, name: true, email: true, role: true, kind: true, userId: true, rsvp: { select: { status: true, checkInToken: true } } },
  });
}

/** Whether the crew member holds an approved place on another shift that overlaps this one. */
export async function hasOverlappingDuty(tx: Prisma.TransactionClient, crewMemberId: string, shift: { id: string; startsAt: Date; endsAt: Date }) {
  const clash = await tx.volunteerShiftSignup.findFirst({
    where: { crewMemberId, status: "APPROVED", shiftId: { not: shift.id }, shift: { startsAt: { lt: shift.endsAt }, endsAt: { gt: shift.startsAt } } },
    select: { id: true },
  });
  return Boolean(clash);
}

export function approvedCount(tx: Prisma.TransactionClient, shiftId: string) {
  return tx.volunteerShiftSignup.count({ where: { shiftId, status: "APPROVED" } });
}

/** A crew ticket that still works: confirmed crew RSVP. */
export function crewTicketLive(member: { rsvp: { status: RsvpStatus } } | null) {
  return member?.rsvp.status === RsvpStatus.CONFIRMED;
}

/**
 * Whether `userId` is the volunteer themself: their linked account, or an
 * account with the crew email. Verification and certificates need a second person.
 */
export async function isVolunteerSelf(tx: Prisma.TransactionClient, userId: string, member: { userId: string | null; email: string }) {
  if (member.userId === userId) return true;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
  return user?.email?.trim().toLowerCase() === member.email;
}
