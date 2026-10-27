import "server-only";

/*
 * Office hours (office_hours_workflow.py): a mentor's slots and team
 * bookings. Booking locks the team, then the slot: no overlapping booking
 * for the team, the mentor available for the whole slot, capacity counted
 * under the slot lock, and no team cancellation once the slot has started.
 * Every schedule change is logged with its reason (append-only).
 */

import { OfficeHourBookingStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/audit";
import { coversInterval, OFFICE_HOUR_CAPACITY_MAX, OFFICE_HOUR_LOCATION_MAX_LENGTH, OFFICE_HOUR_REASON_MAX_LENGTH } from "@/lib/mentorDesk/rules";
import { enqueueMentorMessages, OFFICE_HOUR_BOOKED_KIND, OFFICE_HOUR_CANCELLED_KIND } from "@/lib/outbox/mentor";
import { deskEvent, liveMentor, liveParticipant, type DeskOrganiserContext, type MentorContext, type ParticipantContext } from "./access";
import { localToDate } from "./configuration";
import { isBlockedForTeam } from "./eligibility";
import { COPY, checkVersion, type DeskResult, fail, inTransaction, lockTeam, refuse } from "./shared";

type Staff = MentorContext | DeskOrganiserContext;

const slotFields = {
  start: z.string().max(20),
  end: z.string().max(20),
  bookingDeadline: z.string().max(20).optional(),
  location: z.string().trim().max(OFFICE_HOUR_LOCATION_MAX_LENGTH).default(""),
  capacity: z.number().int().min(1).max(OFFICE_HOUR_CAPACITY_MAX).default(1),
};

async function lockSlot(tx: Prisma.TransactionClient, eventId: string, slotId: string) {
  await tx.$queryRaw`SELECT "id" FROM "OfficeHourSlot" WHERE "id" = ${slotId} AND "eventId" = ${eventId} FOR UPDATE`;
  const slot = await tx.officeHourSlot.findFirst({ where: { id: slotId, eventId } });
  if (!slot) refuse(COPY.notFound);
  return slot;
}

/** Emails for every live booking of a slot (or one booking): the team's members and the mentor. */
async function notifyBooking(tx: Prisma.TransactionClient, bookingIds: string[], kind: string) {
  for (const id of bookingIds) {
    const booking = await tx.officeHourBooking.findUniqueOrThrow({ where: { id }, select: { team: { select: { members: { select: { guestEmail: true, user: { select: { email: true } } } } } }, slot: { select: { mentor: { select: { email: true } } } } } });
    const to = [...booking.team.members.map((m) => m.user?.email ?? m.guestEmail), booking.slot.mentor.email].filter((v): v is string => Boolean(v));
    await enqueueMentorMessages(tx, kind, to.map((address) => ({ to: address, id })));
  }
}

/** Parses a slot window in the event's zone and checks it against the event, the mentor and their other slots. */
async function slotWindow(tx: Prisma.TransactionClient, event: { id: string; timezone: string; startDateTime: Date; endDateTime: Date }, mentorUserId: string, input: { start: string; end: string; bookingDeadline?: string }, exceptSlotId?: string) {
  const startsAt = localToDate(input.start, event.timezone);
  const endsAt = localToDate(input.end, event.timezone);
  const bookingDeadline = input.bookingDeadline ? localToDate(input.bookingDeadline, event.timezone) : startsAt;
  if (!startsAt || !endsAt || !bookingDeadline || startsAt >= endsAt || bookingDeadline > startsAt) refuse("Choose a slot inside the event.");
  if (startsAt < event.startDateTime || endsAt > event.endDateTime) refuse("Choose a slot inside the event.");
  const mentor = await liveMentor(tx, event.id, mentorUserId, { onShift: false });
  if (!coversInterval(mentor.availability, startsAt, endsAt)) refuse("The slot must fall inside the mentor's availability.");
  const overlap = await tx.officeHourSlot.findFirst({ where: { eventId: event.id, mentorUserId, cancelledAt: null, startsAt: { lt: endsAt }, endsAt: { gt: startsAt }, ...(exceptSlotId ? { id: { not: exceptSlotId } } : {}) }, select: { id: true } });
  if (overlap) refuse("This overlaps another of the mentor's slots.");
  return { startsAt, endsAt, bookingDeadline };
}

const createSchema = z.object({ mentorUserId: z.string().min(1).max(128), ...slotFields }).strict();

/** A mentor opens a slot of their own; an organiser opens one for any mentor. */
export async function createOfficeHourSlot(actor: Staff, input: unknown): Promise<DeskResult<{ id: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  if (actor.kind === "mentor" && parsed.data.mentorUserId !== actor.userId) return fail(COPY.notFound);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, actor);
    const window = await slotWindow(tx, event, parsed.data.mentorUserId, parsed.data);
    return tx.officeHourSlot.create({ data: { eventId: event.id, mentorUserId: parsed.data.mentorUserId, ...window, location: parsed.data.location, capacity: parsed.data.capacity }, select: { id: true } });
  });
}

const changeSchema = z.object({ slotId: z.string().min(1).max(128), expectedVersion: z.number().int().min(1), reason: z.string().trim().min(1).max(OFFICE_HOUR_REASON_MAX_LENGTH) });

function scheduleOf(slot: { startsAt: Date; endsAt: Date; location: string; capacity: number; cancelledAt: Date | null }) {
  return { startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), location: slot.location, capacity: slot.capacity, cancelled: Boolean(slot.cancelledAt) };
}

async function ownedSlot(tx: Prisma.TransactionClient, actor: Staff, eventId: string, slotId: string, expectedVersion: number) {
  const slot = await lockSlot(tx, eventId, slotId);
  if (actor.kind === "mentor" && slot.mentorUserId !== actor.userId) refuse(COPY.notFound);
  checkVersion(slot, expectedVersion);
  if (slot.cancelledAt) refuse(COPY.slotClosed);
  return slot;
}

/** Moves or resizes a slot, with a reason. Booked teams must still fit and are told about the new time. */
export async function rescheduleOfficeHourSlot(actor: Staff, input: unknown): Promise<DeskResult> {
  const parsed = changeSchema.extend(slotFields).strict().safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, actor);
    const slot = await ownedSlot(tx, actor, event.id, parsed.data.slotId, parsed.data.expectedVersion);
    const window = await slotWindow(tx, event, slot.mentorUserId, parsed.data, slot.id);
    const booked = await tx.officeHourBooking.findMany({ where: { slotId: slot.id, status: OfficeHourBookingStatus.BOOKED }, select: { id: true } });
    if (booked.length > parsed.data.capacity) refuse("Capacity cannot drop below the teams already booked.");
    const next = await tx.officeHourSlot.update({ where: { id: slot.id }, data: { ...window, location: parsed.data.location, capacity: parsed.data.capacity, version: { increment: 1 } } });
    await tx.officeHourChange.create({ data: { eventId: event.id, slotId: slot.id, actorUserId: actor.userId, reason: parsed.data.reason, oldSchedule: scheduleOf(slot), newSchedule: scheduleOf(next) } });
    if (slot.startsAt.getTime() !== next.startsAt.getTime() || slot.endsAt.getTime() !== next.endsAt.getTime() || slot.location !== next.location) {
      await notifyBooking(tx, booked.map((b) => b.id), OFFICE_HOUR_BOOKED_KIND);
    }
    return undefined;
  });
}

/** Cancels a slot and its bookings, with a reason. */
export async function cancelOfficeHourSlot(actor: Staff, input: unknown): Promise<DeskResult> {
  const parsed = changeSchema.strict().safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, actor, { allowDisabled: actor.kind === "organiser" });
    const slot = await ownedSlot(tx, actor, event.id, parsed.data.slotId, parsed.data.expectedVersion);
    const now = new Date();
    const next = await tx.officeHourSlot.update({ where: { id: slot.id }, data: { cancelledAt: now, version: { increment: 1 } } });
    const booked = await tx.officeHourBooking.findMany({ where: { slotId: slot.id, status: OfficeHourBookingStatus.BOOKED }, select: { id: true } });
    await tx.officeHourBooking.updateMany({ where: { slotId: slot.id, status: OfficeHourBookingStatus.BOOKED }, data: { status: OfficeHourBookingStatus.CANCELLED, cancelledAt: now, cancelReason: "slot_changed" } });
    await tx.officeHourChange.create({ data: { eventId: event.id, slotId: slot.id, actorUserId: actor.userId, reason: parsed.data.reason, oldSchedule: scheduleOf(slot), newSchedule: scheduleOf(next) } });
    await notifyBooking(tx, booked.map((b) => b.id), OFFICE_HOUR_CANCELLED_KIND);
    return undefined;
  });
}

/** office_hours_workflow.book: a team member (or the team's management link) books a place. */
export async function bookOfficeHour(p: ParticipantContext, input: unknown): Promise<DeskResult<{ id: string }>> {
  const parsed = z.object({ slotId: z.string().min(1).max(128), expectedVersion: z.number().int().min(1) }).safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, p);
    const { teamId } = await liveParticipant(tx, p);
    if (!teamId) refuse(COPY.teamOnly);
    await lockTeam(tx, teamId);
    const slot = await lockSlot(tx, event.id, parsed.data.slotId);
    checkVersion(slot, parsed.data.expectedVersion);
    const now = new Date();
    if (slot.cancelledAt || slot.startsAt <= now || slot.bookingDeadline <= now) refuse(COPY.slotClosed);
    const mentor = await liveMentor(tx, event.id, slot.mentorUserId, { onShift: false });
    if (!coversInterval(mentor.availability, slot.startsAt, slot.endsAt)) refuse(COPY.bookingConflict);
    if (await isBlockedForTeam(tx, event.id, slot.mentorUserId, teamId)) refuse(COPY.bookingConflict);
    const overlap = { eventId: event.id, status: OfficeHourBookingStatus.BOOKED, slot: { startsAt: { lt: slot.endsAt }, endsAt: { gt: slot.startsAt } } };
    if (await tx.officeHourBooking.findFirst({ where: { ...overlap, teamId }, select: { id: true } })) refuse(COPY.teamOverlap);
    if (await tx.officeHourBooking.findFirst({ where: { ...overlap, slotId: { not: slot.id }, slot: { ...overlap.slot, mentorUserId: slot.mentorUserId } }, select: { id: true } })) refuse(COPY.bookingConflict);
    const taken = await tx.officeHourBooking.count({ where: { slotId: slot.id, status: OfficeHourBookingStatus.BOOKED } });
    if (taken >= slot.capacity) refuse(COPY.slotFull);
    const booking = await tx.officeHourBooking.create({ data: { eventId: event.id, slotId: slot.id, teamId, bookedByUserId: p.userId }, select: { id: true } });
    await notifyBooking(tx, [booking.id], OFFICE_HOUR_BOOKED_KIND);
    return booking;
  }, COPY.teamOverlap);
}

/** The team cancels its own booking before the slot starts. */
export async function cancelOfficeHourBooking(p: ParticipantContext, input: unknown): Promise<DeskResult> {
  const parsed = z.object({ bookingId: z.string().min(1).max(128) }).safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, p, { allowDisabled: true });
    const { teamId } = await liveParticipant(tx, p);
    const booking = await tx.officeHourBooking.findFirst({ where: { id: parsed.data.bookingId, eventId: event.id, teamId: teamId ?? "" }, select: { id: true, slotId: true, status: true } });
    if (!booking || !teamId) refuse(COPY.notFound);
    const slot = await lockSlot(tx, event.id, booking.slotId);
    if (booking.status !== OfficeHourBookingStatus.BOOKED) refuse(COPY.stale);
    if (slot.startsAt <= new Date()) refuse(COPY.slotStarted);
    await tx.officeHourBooking.update({ where: { id: booking.id }, data: { status: OfficeHourBookingStatus.CANCELLED, cancelledAt: new Date(), cancelReason: "team_cancelled" } });
    await notifyBooking(tx, [booking.id], OFFICE_HOUR_CANCELLED_KIND);
    return undefined;
  });
}

/** An organiser cancels any booking, at any time. */
export async function cancelBookingAsOrganiser(ctx: DeskOrganiserContext, input: unknown): Promise<DeskResult> {
  const parsed = z.object({ bookingId: z.string().min(1).max(128) }).safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, ctx, { allowDisabled: true });
    const booking = await tx.officeHourBooking.findFirst({ where: { id: parsed.data.bookingId, eventId: event.id }, select: { id: true, slotId: true, status: true } });
    if (!booking) refuse(COPY.notFound);
    await lockSlot(tx, event.id, booking.slotId);
    if (booking.status !== OfficeHourBookingStatus.BOOKED) refuse(COPY.stale);
    await tx.officeHourBooking.update({ where: { id: booking.id }, data: { status: OfficeHourBookingStatus.CANCELLED, cancelledAt: new Date(), cancelReason: "organiser" } });
    await notifyBooking(tx, [booking.id], OFFICE_HOUR_CANCELLED_KIND);
    await recordAuditEvent({ client: tx, action: "MENTOR_OFFICE_HOUR_CANCELLED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "OfficeHourBooking", targetId: booking.id });
    return undefined;
  });
}
