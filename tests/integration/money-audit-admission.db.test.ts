import { OfflinePaymentMethod, OrderStatus, PaymentStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { respondAsApplicant } from "@/lib/admission/respond";
import { startCheckout } from "@/lib/payments/checkout";
import { AdmissionManagedError, settleOrderByHand } from "@/lib/payments/operations";
import { payOrder } from "./helpers/paidOrg";
import { apply, createAdmissionEvent, decide, paid, people, rsvpOf, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * Paid places on admission events (docs/ADMISSION.md "Paid places"): a solo
 * applicant on a TEAM event takes one unit, so a team of several people
 * never makes the event look full; and an applicant's place is never waived
 * by hand, though money taken at the desk can be recorded.
 */

beforeAll(() => setUpAdmission("Money audit applications"));
afterAll(() => tearDownAdmission());

describe.sequential("paid applications: units and waivers", () => {
  it("offers a paid solo place on a TEAM event while a unit is free, and refuses to waive it", async () => {
    const { event, ticket, ctx } = await createAdmissionEvent({ team: true, price: 49900, capacity: 2 });
    // A paid team of two people takes one of the two units.
    const leader = await apply(event, "lead", { ticketTypeId: ticket!.id, team: { mode: "create", name: `Units ${paid.suffix.slice(0, 6)}` } });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: leader.rsvp.teamId! } });
    await apply(event, "mate", { team: { mode: "join", joinToken: team.joinToken } });
    await decide(ctx, [leader.application.id], "ACCEPT");
    expect(await respondAsApplicant(leader.token, "accept")).toMatchObject({ ok: true, paying: true });
    const teamOrder = await prisma.order.findFirstOrThrow({ where: { teamId: team.id } });
    await startCheckout(teamOrder.id);
    expect((await payOrder(teamOrder.id)).outcome).toBe("confirmed");
    expect(await prisma.rSVP.count({ where: { eventId: event.id, status: RsvpStatus.CONFIRMED } })).toBe(2);

    // Two people are confirmed against a capacity of two units, yet one unit is free.
    const solo = await apply(event, "solo", { ticketTypeId: ticket!.id });
    await decide(ctx, [solo.application.id], "ACCEPT");
    expect(await respondAsApplicant(solo.token, "accept")).toMatchObject({ ok: true, paying: true });
    expect((await rsvpOf(solo.rsvp.id)).status).toBe(RsvpStatus.PENDING_PAYMENT);

    // Never waived: the place stays held and unpaid.
    const order = await prisma.order.findFirstOrThrow({ where: { rsvps: { some: { id: solo.rsvp.id } } } });
    const waive = settleOrderByHand({ orderId: order.id, organisationId: paid.organisationId, actorUserId: people.owner, mode: "waive" });
    await expect(waive).rejects.toBeInstanceOf(AdmissionManagedError);
    await expect(waive).rejects.toMatchObject({ code: "ADMISSION_MANAGED" });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: OrderStatus.PENDING });
    expect(await prisma.payment.count({ where: { orderId: order.id, status: PaymentStatus.WAIVED } })).toBe(0);

    // Money taken at the desk is recorded and confirms the place.
    expect(await settleOrderByHand({ orderId: order.id, organisationId: paid.organisationId, actorUserId: people.owner, mode: "offline", method: OfflinePaymentMethod.CASH })).toBe("confirmed");
    expect((await rsvpOf(solo.rsvp.id)).status).toBe(RsvpStatus.CONFIRMED);

    // Now both units are taken: the next solo applicant can't be offered a paid place.
    const late = await apply(event, "late", { ticketTypeId: ticket!.id });
    await decide(ctx, [late.application.id], "ACCEPT").catch(() => undefined);
    expect(await respondAsApplicant(late.token, "accept")).toMatchObject({ ok: false });
    expect((await rsvpOf(late.rsvp.id)).status).not.toBe(RsvpStatus.PENDING_PAYMENT);
  });
});
