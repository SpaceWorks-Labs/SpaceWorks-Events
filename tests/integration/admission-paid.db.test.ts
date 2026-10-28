import { AdmissionStatus, OrderStatus, RegistrationMode, RsvpStatus, SoloPolicy, TeamTicketMode } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { respondAsApplicant } from "@/lib/admission/respond";
import { PER_MEMBER_PAID_REFUSAL, setAdmissionEnabled } from "@/lib/admission/settings";
import { startCheckout } from "@/lib/payments/checkout";
import { drainApplicationEvents } from "@/lib/admission/statusEvents";
import { MANUAL_PAID_REFUSAL } from "@/lib/admission/registration";
import { submitManualTicketOrderCore } from "@/lib/rsvpCore/manual";
import { payOrder } from "./helpers/paidOrg";
import { appOf, apply, createAdmissionEvent, decide, organiserCtx, paid, rsvpOf, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * Paid places (docs/ADMISSION.md "Paid places"): a place is never confirmed
 * unpaid. An offer leaves the order REQUESTED with nothing held; "Accept and
 * pay" holds the place while the payment link is paid; the payment confirms
 * it. On a team event the leader pays once for the team (PER_TEAM).
 */

beforeAll(() => setUpAdmission("Paid applications"));
afterAll(() => tearDownAdmission());

describe.sequential("paid applications", () => {
  it("confirms a paid solo place only when its payment settles", async () => {
    const { event, ticket, ctx } = await createAdmissionEvent({ price: 49900 });
    const a = await apply(event, "payer", { ticketTypeId: ticket!.id });
    const order = await prisma.order.findFirstOrThrow({ where: { eventId: event.id } });
    expect(order.status).toBe(OrderStatus.REQUESTED);
    expect(a.application.status).toBe(AdmissionStatus.IN_REVIEW);
    // Nothing confirms an application without an offer, whatever path tries.
    await expect(prisma.rSVP.update({ where: { id: a.rsvp.id }, data: { status: RsvpStatus.CONFIRMED } })).rejects.toThrow(/admission_review_required/);

    await decide(ctx, [a.application.id], "ACCEPT");
    expect((await rsvpOf(a.rsvp.id)).status).toBe(RsvpStatus.PENDING_APPROVAL);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.REQUESTED);

    expect(await respondAsApplicant(a.token, "accept")).toEqual({ ok: true, status: AdmissionStatus.OFFERED, paying: true });
    expect(await rsvpOf(a.rsvp.id)).toMatchObject({ status: RsvpStatus.PENDING_PAYMENT, holdExpiresAt: expect.any(Date) });
    expect(await appOf(a.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED });
    // A second click while paying changes nothing; declining is refused until the hold ends.
    expect(await respondAsApplicant(a.token, "accept")).toMatchObject({ ok: true, paying: true });
    expect(await respondAsApplicant(a.token, "decline")).toMatchObject({ ok: false });

    await startCheckout(order.id);
    expect((await payOrder(order.id)).outcome).toBe("confirmed");
    expect((await rsvpOf(a.rsvp.id)).status).toBe(RsvpStatus.CONFIRMED);
    expect(await appOf(a.application.id)).toMatchObject({ status: AdmissionStatus.ACCEPTED });
    // The trigger-made transition is recorded and sent as a webhook after commit.
    await drainApplicationEvents();
    expect(await prisma.admissionStatusEvent.count({ where: { applicationId: a.application.id, status: AdmissionStatus.ACCEPTED, previousStatus: AdmissionStatus.OFFERED, emittedAt: { not: null } } })).toBe(1);

    // An organiser can't add a paid guest who would skip review and the offer.
    const manual = await submitManualTicketOrderCore({ eventId: event.id, name: "Walk-in", guestEmail: `walkin-${paid.suffix}@example.test`, ticketTypeId: ticket!.id, payment: "offline", answers: {} }, { organisationId: paid.organisationId, actorUserId: ctx.userId });
    expect(manual).toMatchObject({ ok: false, error: MANUAL_PAID_REFUSAL });
  });

  it("has the team leader pay once for the team and confirms every member with the payment", async () => {
    const { event, ticket, ctx } = await createAdmissionEvent({ team: true, price: 99900 });
    const leader = await apply(event, "lead", { ticketTypeId: ticket!.id, team: { mode: "create", name: `Paid crew ${paid.suffix.slice(0, 6)}` } });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: leader.rsvp.teamId! } });
    expect(team.status).toBe(RsvpStatus.PENDING_APPROVAL);
    const member = await apply(event, "mate", { team: { mode: "join", joinToken: team.joinToken } });
    expect(member.application.id).toBe(leader.application.id);
    const order = await prisma.order.findFirstOrThrow({ where: { teamId: team.id } });
    expect(order).toMatchObject({ status: OrderStatus.REQUESTED, teamName: team.name });

    await expect(prisma.team.update({ where: { id: team.id }, data: { status: RsvpStatus.CONFIRMED } })).rejects.toThrow(/admission_review_required/);
    await decide(ctx, [leader.application.id], "ACCEPT");
    expect(await respondAsApplicant(member.token, "accept")).toMatchObject({ ok: false });
    expect(await respondAsApplicant(leader.token, "accept")).toMatchObject({ ok: true, paying: true });
    expect(await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).toMatchObject({ status: RsvpStatus.PENDING_PAYMENT });
    expect((await rsvpOf(leader.rsvp.id)).status).toBe(RsvpStatus.PENDING_PAYMENT);
    expect((await rsvpOf(member.rsvp.id)).status).toBe(RsvpStatus.PENDING_APPROVAL);

    await startCheckout(order.id);
    expect((await payOrder(order.id)).outcome).toBe("confirmed");
    expect(await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).toMatchObject({ status: RsvpStatus.CONFIRMED });
    expect((await rsvpOf(leader.rsvp.id)).status).toBe(RsvpStatus.CONFIRMED);
    expect((await rsvpOf(member.rsvp.id)).status).toBe(RsvpStatus.CONFIRMED);
    expect(await appOf(leader.application.id)).toMatchObject({ status: AdmissionStatus.ACCEPTED });
    expect(await prisma.outboxMessage.count({ where: { kind: "rsvp-confirmation", AND: [{ payload: { path: ["checkInToken"], equals: member.token } }, { payload: { path: ["status"], equals: RsvpStatus.CONFIRMED } }] } })).toBe(1);
  });

  it("treats a free ticket type on a paid event as free", async () => {
    const { event, ticket, ctx } = await createAdmissionEvent({ price: 49900 });
    const free = await prisma.ticketType.create({ data: { eventId: event.id, name: "Scholarship", priceMinor: BigInt(0), maxPerOrder: 1 } });
    const a = await apply(event, "scholar", { ticketTypeId: free.id });
    await decide(ctx, [a.application.id], "ACCEPT");
    expect(await respondAsApplicant(a.token, "accept")).toEqual({ ok: true, status: AdmissionStatus.ACCEPTED, paying: false });
    expect((await rsvpOf(a.rsvp.id)).status).toBe(RsvpStatus.CONFIRMED);
    expect(await prisma.payment.count({ where: { order: { eventId: event.id } } })).toBe(0);
    expect(ticket).toBeTruthy();
  });

  it("refuses paid applications where every team member would pay for themselves", async () => {
    const event = await prisma.event.create({ data: {
      organisationId: paid.organisationId, title: "Per member", slug: `per-member-${paid.suffix}`, currency: "INR",
      startDateTime: new Date("2035-01-01T10:00:00.000Z"), endDateTime: new Date("2035-01-02T10:00:00.000Z"), timezone: "UTC",
      registrationMode: RegistrationMode.TEAM, teamMaxSize: 4, soloPolicy: SoloPolicy.SOLO_ALLOWED, teamTicketMode: TeamTicketMode.PER_MEMBER,
    } });
    await prisma.ticketType.create({ data: { eventId: event.id, name: "Entry", priceMinor: BigInt(100) } });
    expect(await setAdmissionEnabled(organiserCtx(event), true)).toEqual({ ok: false, error: PER_MEMBER_PAID_REFUSAL });
    await prisma.event.update({ where: { id: event.id }, data: { teamTicketMode: TeamTicketMode.PER_TEAM } });
    expect(await setAdmissionEnabled(organiserCtx(event), true)).toEqual({ ok: true });
  });
});
