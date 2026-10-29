import "server-only";

import { RegistrationMode, RsvpStatus, type Prisma } from "@prisma/client";
import { countConfirmedForCapacity } from "@/lib/teamUnits";
import type { SeatTarget } from "@/lib/payments/targets";

/**
 * The registration count a registrant sees after signing up: the number on
 * the page they registered from, or null when the event hides it
 * (`showRegistrationCount`). An event counts as its page does: team units
 * ("places taken") on a TEAM event, otherwise confirmed attendees plus crew
 * tickets ("going"). A series date has no such setting and shows its
 * confirmed registrations, as its page does. Capacity checks never use this.
 */
export async function publicRegistrationCount(tx: Prisma.TransactionClient, target: SeatTarget): Promise<number | null> {
  if ("eventInstanceId" in target) return tx.rSVP.count({ where: { eventInstanceId: target.eventInstanceId, status: RsvpStatus.CONFIRMED } });
  const event = await tx.event.findUnique({ where: { id: target.eventId }, select: { showRegistrationCount: true, registrationMode: true } });
  if (!event?.showRegistrationCount) return null;
  const confirmed = await countConfirmedForCapacity(tx, target.eventId, event.registrationMode);
  if (event.registrationMode === RegistrationMode.TEAM) return confirmed;
  return confirmed + await tx.rSVP.count({ where: { eventId: target.eventId, isCrew: true, status: RsvpStatus.CONFIRMED } });
}

/** The `count` of a registration result: left out when the event hides it. */
export function publicCountField(count: number | null): { count?: number } {
  return count === null ? {} : { count };
}
