import { EventStatus, Prisma, RegistrationMode, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { countConfirmedUnits } from "@/lib/teamUnits";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import { enqueueRsvpConfirmation, enqueueRsvpStatusNotification } from "@/lib/outbox";
import { seatTakingWhere } from "@/lib/payments/holds";
import { lockDate } from "@/lib/payments/targets";

export { countConfirmedUnits };

/**
 * Confirmed count shown against `Event.capacity`. Pass the event's
 * `registrationMode` so TEAM events count registration units (teams plus solo
 * registrants); INDIVIDUAL events count confirmed RSVPs as before.
 */
export async function countConfirmedForEvent(eventId: string, registrationMode?: RegistrationMode): Promise<number> {
  if (registrationMode === RegistrationMode.TEAM) {
    const [teams, solo] = await Promise.all([
      prisma.team.count({ where: { eventId, status: RsvpStatus.CONFIRMED } }),
      prisma.rSVP.count({ where: { eventId, teamId: null, status: RsvpStatus.CONFIRMED } }),
    ]);
    return teams + solo;
  }
  return prisma.rSVP.count({
    where: { eventId, status: RsvpStatus.CONFIRMED },
  });
}

/** Paid-ticket seats currently held while buyers pay. */
export async function countHeldForEvent(eventId: string, now = new Date()): Promise<number> {
  return prisma.rSVP.count({
    where: { eventId, status: RsvpStatus.PENDING_PAYMENT, holdExpiresAt: { gt: now } },
  });
}

/** Registrations from a paid order are confirmed only by its payment. */
export const NOT_FROM_PAID_ORDER = { OR: [{ orderId: null }, { order: { totalMinor: 0 } }] } satisfies Prisma.RSVPWhereInput;

export async function countConfirmedForInstance(
  eventInstanceId: string,
): Promise<number> {
  return prisma.rSVP.count({
    where: { eventInstanceId, status: RsvpStatus.CONFIRMED },
  });
}

/** Caller must already be inside the restore transaction. Uses the same target
 * row lock as new reservations so an undo cannot race a final-slot claim. */
export async function hasCapacityToRestoreConfirmedRsvp(
  tx: Prisma.TransactionClient,
  target: { eventId: string } | { eventInstanceId: string },
): Promise<boolean> {
  let capacity: number | null;
  if ("eventId" in target) {
    const rows = await tx.$queryRaw<Array<{ capacity: number | null; registrationMode?: RegistrationMode }>>`
      SELECT "capacity", "registrationMode" FROM "Event" WHERE "id" = ${target.eventId} FOR UPDATE
    `;
    if (!rows[0]) return false;
    capacity = rows[0].capacity;
    // TEAM events count registration units; a restored solo RSVP is one unit.
    if (rows[0].registrationMode === RegistrationMode.TEAM) {
      return capacity == null || (await countConfirmedUnits(tx, target.eventId)) < capacity;
    }
  } else {
    const date = await lockDate(tx, target.eventInstanceId, new Date());
    if (!date) return false;
    capacity = date.capacity;
  }
  if (capacity == null) return true;
  const taken = await tx.rSVP.count({ where: { ...target, ...seatTakingWhere(new Date()) } });
  return taken < capacity;
}

/** Atomically promote/approve an RSVP without exceeding the configured capacity. */
export async function confirmRsvpWithinCapacity(params: {
  rsvpId: string;
  eventId?: string;
  eventInstanceId?: string;
  expectedStatuses: RsvpStatus[];
  /** Approval requests must not be confirmed after their event has ended or been unpublished. */
  requireOpen?: boolean;
  notification?: { to: string; eventTitle: string; checkInToken: string };
  /**
   * What to do when there is no room. By default the RSVP is left unchanged
   * and "full" is returned. "waitlist" instead moves it to WAITLISTED in the
   * same locked transaction and queues the waitlist email, so an organiser can
   * later promote it like any other waitlisted guest.
   */
  whenFull?: "reject" | "waitlist";
}): Promise<"confirmed" | "waitlisted" | "full" | "changed" | "closed"> {
  const target = params.eventId ? { eventId: params.eventId } : { eventInstanceId: params.eventInstanceId! };
  const outcome = await prisma.$transaction(async (tx): Promise<"confirmed" | "waitlisted" | "full" | "changed" | "closed"> => {
    let capacity: number | null;
    let isOpen: boolean;
    let teamMode = false;
    if (params.eventId) {
      const events = await tx.$queryRaw<Array<{ capacity: number | null; status: EventStatus; endDateTime: Date; registrationMode?: RegistrationMode }>>`
        SELECT "capacity", "status", "endDateTime", "registrationMode" FROM "Event" WHERE "id" = ${params.eventId} FOR UPDATE
      `;
      const event = events[0];
      if (!event) return "changed";
      capacity = event.capacity;
      isOpen = event.status === EventStatus.PUBLISHED && event.endDateTime > new Date();
      teamMode = event.registrationMode === RegistrationMode.TEAM;
    } else {
      // The series, then the date: the same lock order as every series path.
      const date = await lockDate(tx, params.eventInstanceId!, new Date());
      if (!date) return "changed";
      capacity = date.capacity;
      isOpen = date.open;
    }
    if (params.requireOpen && !isOpen) return "closed";
    // TEAM events count units, and only solo RSVPs are confirmed one by one:
    // team members change status with their whole team (lib/core/teams.ts).
    const taken = teamMode
      ? await countConfirmedUnits(tx, params.eventId!)
      : await tx.rSVP.count({ where: { ...target, ...seatTakingWhere(new Date()) } });
    const soloOnly = teamMode ? { teamId: null } : {};
    if (capacity != null && taken >= capacity) {
      if (params.whenFull !== "waitlist") return "full";
      const waitlisted = await tx.rSVP.updateMany({
        where: { id: params.rsvpId, ...target, status: { in: params.expectedStatuses }, ...NOT_FROM_PAID_ORDER, ...soloOnly },
        data: { status: RsvpStatus.WAITLISTED },
      });
      if (waitlisted.count === 1 && params.notification) {
        await enqueueRsvpConfirmation(tx, { ...params.notification, status: RsvpStatus.WAITLISTED });
      }
      return waitlisted.count === 1 ? "waitlisted" : "changed";
    }
    const updated = await tx.rSVP.updateMany({
      where: { id: params.rsvpId, ...target, status: { in: params.expectedStatuses }, ...NOT_FROM_PAID_ORDER, ...soloOnly },
      data: { status: RsvpStatus.CONFIRMED },
    });
    if (updated.count === 1 && params.notification) {
      await enqueueRsvpStatusNotification(tx, {
        ...params.notification,
        approved: true,
      });
    }
    return updated.count === 1 ? "confirmed" : "changed";
  });
  if (outcome === "confirmed" || outcome === "waitlisted") {
    emitWebhookEvent({
      type: "registration.status_changed",
      rsvpId: params.rsvpId,
      status: outcome === "confirmed" ? RsvpStatus.CONFIRMED : RsvpStatus.WAITLISTED,
      previousStatus: params.expectedStatuses.length === 1 ? params.expectedStatuses[0]! : null,
    });
  }
  return outcome;
}
