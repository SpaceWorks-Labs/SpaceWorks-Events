import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { attendanceEligibleRsvpWhere } from "@/lib/attendanceEligibility";

/**
 * Whether this registration may still be asked or answer: one query with the
 * shared rule (lib/attendanceEligibility.ts). Kept free of the auth and
 * payment modules, so the outbox worker can use it.
 */
export async function isEligibleRsvp(client: Prisma.TransactionClient | typeof prisma, rsvpId: string, eventId: string) {
  return (await client.rSVP.count({ where: { AND: [{ id: rsvpId }, attendanceEligibleRsvpWhere(eventId)] } })) === 1;
}
