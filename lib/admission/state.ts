import "server-only";

import { AdmissionStatus, OrderStatus, Prisma, RegistrationMode, RsvpStatus } from "@prisma/client";
import { countConfirmedUnits } from "@/lib/teamUnits";
import { seatTakingWhere } from "@/lib/payments/holds";
import type { RegistrationStatusWebhook } from "@/lib/teamUnits";
import { OFFER_HOLDING } from "./rules";

/*
 * Shared transaction helpers for applications (docs/ADMISSION.md). Every
 * caller holds the Event row lock (`lockAdmissionEvent`) before reading or
 * changing an application, then its registrations, then any order: the same
 * order as every registration and payment path.
 */

export class AdmissionError extends Error {}

export const CHANGED = "This application was changed by someone else. Refresh and try again.";

export const admissionEventSelect = {
  id: true,
  organisationId: true,
  title: true,
  slug: true,
  status: true,
  startDateTime: true,
  endDateTime: true,
  timezone: true,
  capacity: true,
  registrationMode: true,
  teamMinSize: true,
  teamTicketMode: true,
  submissionsEnabled: true,
  admissionEnabled: true,
  admissionMode: true,
  admissionRsvpDays: true,
  admissionOfferCapacity: true,
  emailApplicantsOnStageAdvance: true,
  organisation: { select: { slug: true } },
} as const satisfies Prisma.EventSelect;

export type AdmissionEvent = Prisma.EventGetPayload<{ select: typeof admissionEventSelect }>;

/** Lock the Event row and read it; null when the event is gone or not in the organisation. */
export async function lockAdmissionEvent(tx: Prisma.TransactionClient, eventId: string, organisationId?: string): Promise<AdmissionEvent | null> {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
  return tx.event.findFirst({ where: { id: eventId, ...(organisationId ? { organisationId } : {}) }, select: admissionEventSelect });
}

export const applicationSelect = {
  id: true,
  eventId: true,
  rsvpId: true,
  teamId: true,
  status: true,
  currentStageId: true,
  version: true,
  decisionRevision: true,
  answersRevision: true,
  answersLockedAt: true,
  respondBy: true,
  offeredAt: true,
  queuedAt: true,
  submittedAt: true,
} as const satisfies Prisma.AdmissionApplicationSelect;

export type ApplicationRow = Prisma.AdmissionApplicationGetPayload<{ select: typeof applicationSelect }>;

/**
 * Change an application, guarded by the version it was read at (refused with
 * CHANGED otherwise). Every state change bumps the version.
 */
export async function updateApplication(tx: Prisma.TransactionClient, app: Pick<ApplicationRow, "id" | "version">, data: Prisma.AdmissionApplicationUncheckedUpdateManyInput): Promise<void> {
  const updated = await tx.admissionApplication.updateMany({ where: { id: app.id, version: app.version }, data: { ...data, version: { increment: 1 } } });
  if (updated.count !== 1) throw new AdmissionError(CHANGED);
}

const memberSelect = { id: true, status: true, holdExpiresAt: true, orderId: true, ticketTypeId: true, checkInToken: true, guestEmail: true, guestName: true, user: { select: { email: true, name: true } } } as const;
export type UnitMember = Prisma.RSVPGetPayload<{ select: typeof memberSelect }>;

/** The registrations an application stands for: the solo RSVP, or every team member (leader first). */
export async function unitMembers(tx: Prisma.TransactionClient, app: Pick<ApplicationRow, "rsvpId" | "teamId">): Promise<UnitMember[]> {
  if (app.rsvpId) return tx.rSVP.findMany({ where: { id: app.rsvpId }, select: memberSelect });
  const team = await tx.team.findUnique({ where: { id: app.teamId! }, select: { leaderRsvpId: true } });
  const members = await tx.rSVP.findMany({ where: { teamId: app.teamId! }, select: memberSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return members.sort((a, b) => Number(b.id === team?.leaderRsvpId) - Number(a.id === team?.leaderRsvpId));
}

/** The order that pays for the place: the solo registration's, or the team leader's (PER_TEAM). */
export async function unitOrder(tx: Prisma.TransactionClient, app: Pick<ApplicationRow, "rsvpId" | "teamId">) {
  const select = { id: true, status: true, totalMinor: true, holdExpiresAt: true } as const;
  if (app.rsvpId) {
    const rsvp = await tx.rSVP.findUnique({ where: { id: app.rsvpId }, select: { order: { select } } });
    return rsvp?.order ?? null;
  }
  return tx.order.findFirst({ where: { teamId: app.teamId!, teamName: { not: null } }, select, orderBy: { createdAt: "asc" } });
}

/** Whether accepting costs money: an order with a total above zero. A free ticket type on a paid event is free. */
export function isPaid(order: { totalMinor: bigint } | null): order is { totalMinor: bigint; id: string; status: OrderStatus; holdExpiresAt: Date | null } {
  return Boolean(order && order.totalMinor > BigInt(0));
}

/**
 * Move every registration of the application (and its team) to `to`, from
 * any other status. Returns one status webhook per registration that changed
 * (emit after commit).
 */
export async function setUnitStatus(tx: Prisma.TransactionClient, app: Pick<ApplicationRow, "rsvpId" | "teamId">, to: RsvpStatus, holdExpiresAt: Date | null = null): Promise<RegistrationStatusWebhook[]> {
  if (app.teamId) await tx.team.updateMany({ where: { id: app.teamId, status: { not: to } }, data: { status: to } });
  const where = app.rsvpId ? { id: app.rsvpId } : { teamId: app.teamId! };
  const changing = await tx.rSVP.findMany({ where: { ...where, OR: [{ status: { not: to } }, { holdExpiresAt: { not: holdExpiresAt } }] }, select: { id: true, status: true } });
  if (changing.length) await tx.rSVP.updateMany({ where: { id: { in: changing.map((row) => row.id) } }, data: { status: to, holdExpiresAt } });
  return changing.filter((row) => row.status !== to).map((row) => ({ type: "registration.status_changed", rsvpId: row.id, status: to, previousStatus: row.status }));
}

/** Cancel the unit's unpaid order, if any: a request still waiting, or one whose hold ended. Nothing was charged. */
export async function cancelUnpaidOrder(tx: Prisma.TransactionClient, app: Pick<ApplicationRow, "rsvpId" | "teamId">): Promise<void> {
  const order = await unitOrder(tx, app);
  if (!order || !isPaid(order)) return;
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
  await tx.order.updateMany({ where: { id: order.id, status: { in: [OrderStatus.REQUESTED, OrderStatus.EXPIRED] } }, data: { status: OrderStatus.CANCELLED, holdExpiresAt: null, holdCapAt: null } });
}

/** Offers out now: OFFERED (including ones being paid) and ACCEPTED applications. */
export async function countOfferHolding(tx: Prisma.TransactionClient, eventId: string): Promise<number> {
  return tx.admissionApplication.count({ where: { eventId, status: { in: [...OFFER_HOLDING] } } });
}

/** Places taken against Event.capacity: confirmed places and live payment holds (units on TEAM events), crew aside. */
export async function placesTaken(tx: Prisma.TransactionClient, event: Pick<AdmissionEvent, "id" | "registrationMode">, now: Date): Promise<number> {
  if (event.registrationMode === RegistrationMode.TEAM) return countConfirmedUnits(tx, event.id, now);
  return tx.rSVP.count({ where: { eventId: event.id, ...seatTakingWhere(now) } });
}

/** Whether a ticket type with a limit still has room for one more place. */
export async function ticketTypeHasRoom(tx: Prisma.TransactionClient, ticketTypeId: string | null, eventId: string, now: Date): Promise<boolean> {
  if (!ticketTypeId) return true;
  const type = await tx.ticketType.findUnique({ where: { id: ticketTypeId }, select: { capacity: true, seatsPerTicket: true } });
  if (!type || type.capacity == null) return true;
  const taken = await tx.rSVP.count({ where: { ticketTypeId, eventId, ...seatTakingWhere(now) } });
  return Math.ceil(taken / type.seatsPerTicket) < type.capacity;
}

/** Offered-but-not-yet-accepted applications holding a ticket type's places, so promotion doesn't over-offer a full type. */
export async function ticketTypeOffers(tx: Prisma.TransactionClient, ticketTypeId: string, eventId: string): Promise<number> {
  return tx.admissionApplication.count({
    where: { eventId, status: AdmissionStatus.OFFERED, OR: [{ rsvp: { ticketTypeId } }, { team: { leaderRsvp: { ticketTypeId } } }] },
  });
}

export function personEmailOf(member: UnitMember): string | null {
  return member.user?.email?.trim() || member.guestEmail?.trim() || null;
}

export function personNameOf(member: UnitMember): string | undefined {
  return member.user?.name?.trim() || member.guestName?.trim() || undefined;
}
