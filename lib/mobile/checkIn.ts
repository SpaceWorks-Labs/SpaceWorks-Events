import "server-only";

import { prisma } from "@/lib/db";
import type { CheckInPreviewData, CheckInResultData, LookupRow } from "@/lib/core/checkin";
import type { z } from "zod";
import { checkInPreviewSchema, checkInResultSchema, guestSchema, type paymentInfoSchema } from "@/lib/mobile/schemas";

/* Mobile check-in DTOs. The QR token used by the web print flow is never returned here. */

export function toCheckInResult(data: CheckInResultData) {
  return checkInResultSchema.parse({
    rsvpId: data.rsvpId,
    displayName: data.displayName,
    email: data.email,
    status: data.status,
    alreadyCheckedIn: data.alreadyCheckedIn,
    checkedInAt: data.checkedInAt,
    checkInDetails: data.checkInDetails,
    registrationDetails: data.registrationDetails.map(({ label, value }) => ({ label, value })),
    ...(data.teamName ? { teamName: data.teamName } : {}),
  });
}

/** The desk's preview, with what is still owed on the guest's order (pay at the desk). */
export function toCheckInPreview(data: CheckInPreviewData, payment: z.infer<typeof paymentInfoSchema> | null = null) {
  return checkInPreviewSchema.parse({ ...toCheckInResult(data), gate: data.gate, payment });
}

export type GuestFacts = Map<string, { registeredAt: string; isGuest: boolean; }>;

/** When each guest registered and whether they came without an account, which the desk's lookup rows leave out. */
export async function loadGuestFacts(eventId: string, rsvpIds: string[]): Promise<GuestFacts> {
  if (rsvpIds.length === 0) return new Map();
  const rows = await prisma.rSVP.findMany({ where: { eventId, id: { in: rsvpIds } }, select: { id: true, createdAt: true, userId: true } });
  return new Map(rows.map((row) => [row.id, { registeredAt: row.createdAt.toISOString(), isGuest: row.userId === null }]));
}

export function lookupRowToGuest(row: LookupRow, facts: GuestFacts) {
  const fact = facts.get(row.rsvpId);
  return guestSchema.parse({
    rsvpId: row.rsvpId,
    displayName: row.displayName,
    email: row.email,
    status: row.status,
    checkedInAt: row.checkedInAt,
    registeredAt: fact?.registeredAt ?? new Date(0).toISOString(),
    isGuest: fact?.isGuest ?? false,
    ...(row.teamName ? { teamName: row.teamName } : {}),
  });
}
