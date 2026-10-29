import { RsvpStatus } from "@prisma/client";
import { expect } from "vitest";
import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { email, paidEvent } from "./attendancePaid";
import { paid } from "./paidOrg";

/** A transferable free ticket on an order, held by a guest other than the buyer. */
export async function holderRegistration(label: string) {
  const { event } = await paidEvent({ kind: "NONE" });
  await prisma.event.update({ where: { id: event.id }, data: { allowTransfers: true, transferCutoffHours: 1, participantClaimsEnabled: true, participantClaimCapMinor: BigInt(100000) } });
  const ticket = await prisma.ticketType.create({ data: { eventId: event.id, name: "Free", priceMinor: BigInt(0) } });
  const result = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: email(label), name: "Original Holder", answers: {}, items: [{ ticketTypeId: ticket.id, quantity: 1 }] }, { userId: null });
  expect(result).toMatchObject({ ok: true, data: { status: RsvpStatus.CONFIRMED } });
  const order = await prisma.order.findFirstOrThrow({ where: { eventId: event.id }, include: { rsvps: true } });
  return { event, order, seat: order.rsvps[0]! };
}
