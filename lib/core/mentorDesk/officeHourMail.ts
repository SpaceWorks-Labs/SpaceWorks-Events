import "server-only";

/** Office-hour booking emails and the schedule log shape, shared by the office-hour commands and the grant lifecycle. */

import { Prisma } from "@prisma/client";
import { enqueueMentorMessages } from "@/lib/outbox/mentor";

/** Queues one email per booking for the team's members and the mentor (ids only; rebuilt at send time). */
export async function notifyBooking(tx: Prisma.TransactionClient, bookingIds: string[], kind: string) {
  for (const id of bookingIds) {
    const booking = await tx.officeHourBooking.findUniqueOrThrow({ where: { id }, select: { team: { select: { members: { select: { guestEmail: true, user: { select: { email: true } } } } } }, slot: { select: { mentor: { select: { email: true } } } } } });
    const to = [...booking.team.members.map((m) => m.user?.email ?? m.guestEmail), booking.slot.mentor.email].filter((v): v is string => Boolean(v));
    await enqueueMentorMessages(tx, kind, to.map((address) => ({ to: address, id })));
  }
}

/** What OfficeHourChange stores before and after a change. */
export function scheduleOf(slot: { startsAt: Date; endsAt: Date; location: string; capacity: number; cancelledAt: Date | null }) {
  return { startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), location: slot.location, capacity: slot.capacity, cancelled: Boolean(slot.cancelledAt) };
}
