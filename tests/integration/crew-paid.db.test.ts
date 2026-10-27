import { EventStatus, ExpenseClaimStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { addCrewMemberAsOrganiser, CREW_EMAIL_REFUSED, type OrganiserCrewContext } from "@/lib/core/crew";
import { approveClaim } from "@/lib/claims/decide";
import { submitParticipantClaim } from "@/lib/claims/submit";
import { loadTicketClaims } from "@/lib/claims/ticketView";
import { transferTicket } from "@/lib/payments/transfers";
import { updateOrderAttendee } from "@/app/actions/orders";
import { countConfirmedForCapacity } from "@/lib/teamUnits";
import { paid, payOrder, setUpPaidOrg, tearDownPaidOrg } from "./helpers/paidOrg";

/*
 * Event crew with Space Works payments and finance (docs/CREW.md): crew
 * tickets never have an order, never take a held seat, are refused by
 * checkout and transfers, a bought ticket never turns into crew, and crew
 * claim expenses (kind CREW) only when the event allows it.
 */

let counter = 0;
let staffId = "";

async function paidEvent(options: { capacity?: number; price?: number; crewClaims?: boolean; transfers?: boolean } = {}) {
  counter += 1;
  const event = await prisma.event.create({ data: {
    organisationId: paid.organisationId, title: `Crew paid ${counter}`, slug: `crew-paid-${paid.suffix}-${counter}`, currency: "INR",
    startDateTime: new Date("2035-01-01T10:00:00.000Z"), endDateTime: new Date("2035-01-01T12:00:00.000Z"), timezone: "UTC", status: EventStatus.PUBLISHED,
    capacity: options.capacity ?? null, crewClaimsEnabled: options.crewClaims ?? false, participantClaimsEnabled: true, participantClaimCapMinor: BigInt(100),
    allowTransfers: options.transfers ?? false, page: { create: { isPublished: true } },
  } });
  const ticket = await prisma.ticketType.create({ data: { eventId: event.id, name: "Entry", priceMinor: BigInt(options.price ?? 49900) } });
  return { event, ticket };
}

const ctx = (eventId: string): OrganiserCrewContext => ({ organisationId: paid.organisationId, eventId, actorUserId: staffId });
const email = (label: string) => `${label}-${(counter += 1)}-${paid.suffix}@example.test`;

async function buy(event: { slug: string }, ticketId: string, buyer: string) {
  const result = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: buyer, name: "Buyer", answers: {}, items: [{ ticketTypeId: ticketId, quantity: 1 }] }, { userId: null });
  return { result, order: await prisma.order.findFirst({ where: { buyerEmail: buyer } }) };
}

beforeAll(async () => {
  await setUpPaidOrg("CrewPaid");
  staffId = (await prisma.user.create({ data: { email: `staff-${paid.suffix}@example.test`, name: "Staff" } })).id;
});
afterAll(async () => {
  await flushWebhookEmits();
  await prisma.user.deleteMany({ where: { email: { endsWith: `${paid.suffix}@example.test` } } });
  await tearDownPaidOrg();
});

describe.sequential("event crew with payments", () => {
  it("keeps crew out of seat holds: one free seat is still sold while crew hold free tickets", async () => {
    const { event, ticket } = await paidEvent({ capacity: 1 });
    const crewResult = await addCrewMemberAsOrganiser(ctx(event.id), { name: "Crew", email: email("crew") });
    expect(crewResult.ok).toBe(true);
    const crewRsvp = await prisma.rSVP.findFirstOrThrow({ where: { eventId: event.id, isCrew: true } });
    expect(crewRsvp).toMatchObject({ orderId: null, ticketTypeId: null, status: RsvpStatus.CONFIRMED });
    await expect(prisma.order.count({ where: { eventId: event.id } })).resolves.toBe(0);

    const { result, order } = await buy(event, ticket.id, email("buyer"));
    expect(result.ok).toBe(true);
    expect(order).not.toBeNull();
    await expect(prisma.rSVP.findFirstOrThrow({ where: { orderId: order!.id } })).resolves.toMatchObject({ status: RsvpStatus.PENDING_PAYMENT });
    // The held seat fills the event (the crew ticket doesn't): a second buyer waits.
    const second = await buy(event, ticket.id, email("second"));
    expect(second.result).toMatchObject({ ok: true, data: { status: RsvpStatus.WAITLISTED } });
    await payOrder(order!.id);
    await expect(prisma.$transaction((tx) => countConfirmedForCapacity(tx, event.id, event.registrationMode))).resolves.toBe(1);
  });

  it("refuses checkout for an email already on the crew", async () => {
    const { event, ticket } = await paidEvent();
    const crewEmail = email("crew");
    expect((await addCrewMemberAsOrganiser(ctx(event.id), { name: "Crew", email: crewEmail })).ok).toBe(true);
    const { result, order } = await buy(event, ticket.id, crewEmail.toUpperCase());
    expect(result).toEqual({ ok: false, error: CREW_EMAIL_REFUSED });
    expect(order).toBeNull();
  });

  it("never turns a bought ticket, a held ticket or a free ticket order into crew", async () => {
    const { event, ticket } = await paidEvent();
    const held = await buy(event, ticket.id, email("held"));
    const paidBuyer = email("paid");
    const bought = await buy(event, ticket.id, paidBuyer);
    await payOrder(bought.order!.id);
    const free = await paidEvent({ price: 0 });
    const freeBuyer = email("free");
    const freeOrder = await buy(free.event, free.ticket.id, freeBuyer);
    expect(freeOrder.result.ok).toBe(true);
    for (const [eventId, buyer] of [[event.id, held.order!.buyerEmail], [event.id, paidBuyer], [free.event.id, freeBuyer]] as const) {
      await expect(addCrewMemberAsOrganiser(ctx(eventId), { name: "Buyer", email: buyer })).resolves.toEqual({ ok: false, error: "This person bought a ticket. Cancel or refund their order first." });
    }
    await expect(prisma.rSVP.count({ where: { eventId: { in: [event.id, free.event.id] }, isCrew: true } })).resolves.toBe(0);
  });

  it("refuses a ticket transfer to a crew member's email", async () => {
    const { event, ticket } = await paidEvent({ transfers: true });
    const crewEmail = email("crew");
    expect((await addCrewMemberAsOrganiser(ctx(event.id), { name: "Crew", email: crewEmail })).ok).toBe(true);
    const { order } = await buy(event, ticket.id, email("buyer"));
    await payOrder(order!.id);
    const rsvp = await prisma.rSVP.findFirstOrThrow({ where: { orderId: order!.id } });
    await expect(transferTicket({ orderToken: order!.accessToken, rsvpId: rsvp.id, name: "Crew", email: crewEmail })).rejects.toThrow(CREW_EMAIL_REFUSED);
  });

  it("refuses a buyer naming a crew member's email on an order's extra ticket", async () => {
    const { event, ticket } = await paidEvent({ price: 0 });
    const crewEmail = email("crew");
    expect((await addCrewMemberAsOrganiser(ctx(event.id), { name: "Crew", email: crewEmail })).ok).toBe(true);
    const buyer = email("group");
    const result = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: buyer, name: "Buyer", answers: {}, items: [{ ticketTypeId: ticket.id, quantity: 2 }] }, { userId: null });
    expect(result.ok).toBe(true);
    const order = await prisma.order.findFirstOrThrow({ where: { buyerEmail: buyer } });
    const extra = await prisma.rSVP.findFirstOrThrow({ where: { orderId: order.id, guestEmail: null } });
    await expect(updateOrderAttendee({ orderToken: order.accessToken, rsvpId: extra.id, name: "Crew", email: crewEmail })).resolves.toEqual({ ok: false, error: CREW_EMAIL_REFUSED });
    await expect(prisma.rSVP.findUniqueOrThrow({ where: { id: extra.id } })).resolves.toMatchObject({ guestEmail: null });
  });

  it("lets crew claim expenses (kind CREW, no cap) only when the event takes crew claims; owners and admins approve", async () => {
    const closed = await paidEvent();
    const open = await paidEvent({ crewClaims: true });
    const claim = (token: string, amount: string) => submitParticipantClaim({ ticketToken: token, actorUserId: null }, { category: "TRAVEL", description: "Van hire", amount }, []);
    for (const target of [closed, open]) expect((await addCrewMemberAsOrganiser(ctx(target.event.id), { name: "Crew", email: email("crew") })).ok).toBe(true);
    const closedTicket = await prisma.rSVP.findFirstOrThrow({ where: { eventId: closed.event.id, isCrew: true } });
    const openTicket = await prisma.rSVP.findFirstOrThrow({ where: { eventId: open.event.id, isCrew: true } });

    // Participant claims are on for both events, but crew use the crew switch.
    await expect(loadTicketClaims(closedTicket)).resolves.toBeNull();
    expect(await claim(closedTicket.checkInToken, "10")).toMatchObject({ ok: false, error: expect.stringContaining("from crew") });
    await expect(loadTicketClaims(openTicket)).resolves.toMatchObject({ crew: true, cap: null });
    // Well above the participant cap of 1 rupee.
    expect(await claim(openTicket.checkInToken, "5000")).toMatchObject({ ok: true });
    const created = await prisma.expenseClaim.findFirstOrThrow({ where: { rsvpId: openTicket.id } });
    expect(created).toMatchObject({ kind: "CREW", status: ExpenseClaimStatus.SUBMITTED, amountMinor: BigInt(500000), eventId: open.event.id });
    expect(await approveClaim({ userId: staffId, organisationId: paid.organisationId }, { claimId: created.id, amount: "5000" })).toEqual({ ok: true, data: undefined });
  });
});
