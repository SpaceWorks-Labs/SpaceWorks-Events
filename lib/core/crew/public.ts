import "server-only";

import { prisma } from "@/lib/db";
import { MAX_CREW_MEMBERS } from "./shared";

/** Public crew cards (docs/CREW.md): never the email, food preference or ticket. */
export type PublicCrewMember = { id: string; name: string; role: string; bio: string; photoUrl: string | null; linkedinUrl: string | null };

/** Members shown on the event page's Crew section, in the organisers' order. */
export async function listPublicCrew(eventId: string): Promise<PublicCrewMember[]> {
  return prisma.eventCrewMember.findMany({
    where: { eventId, showOnPage: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, role: true, bio: true, photoUrl: true, linkedinUrl: true },
    take: MAX_CREW_MEMBERS,
  });
}

/** Crew tickets on an event, counted as "going" beside the attendees (never against capacity). */
export async function countCrewTickets(eventId: string): Promise<number> {
  return prisma.rSVP.count({ where: { eventId, isCrew: true, status: "CONFIRMED" } });
}
