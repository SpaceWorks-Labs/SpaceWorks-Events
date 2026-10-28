import { AdmissionStatus, OrderStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { runAdmissionMaintenance } from "@/lib/admission/maintenance";
import { respondAsApplicant } from "@/lib/admission/respond";
import { runPaymentMaintenance } from "@/lib/payments/maintenance";
import { appOf, apply, createAdmissionEvent, decide, paid, rsvpOf, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * Payment holds on accepted offers (docs/ADMISSION.md "Paid places"): a hold
 * that ends unpaid puts the offer back while its respond-by time lasts, or
 * expires it (and cancels the order) after; offers being paid count against
 * the offer capacity, and a live hold keeps its place from other offers.
 */

beforeAll(() => setUpAdmission("Application holds"));
afterAll(() => tearDownAdmission());

async function endHold(orderId: string) {
  const past = new Date(Date.now() - 1000);
  await prisma.order.update({ where: { id: orderId }, data: { holdExpiresAt: past } });
  await prisma.rSVP.updateMany({ where: { orderId }, data: { holdExpiresAt: past } });
  await runPaymentMaintenance();
}

describe.sequential("application payment holds", () => {
  it("puts an unpaid offer back while it lasts, then expires it and cancels the order", async () => {
    const { event, ticket, ctx } = await createAdmissionEvent({ price: 49900 });
    const a = await apply(event, "slow", { ticketTypeId: ticket!.id });
    await decide(ctx, [a.application.id], "ACCEPT");
    expect(await respondAsApplicant(a.token, "accept")).toMatchObject({ ok: true, paying: true });
    const order = await prisma.order.findFirstOrThrow({ where: { eventId: event.id } });

    await endHold(order.id);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.EXPIRED);
    expect(await runAdmissionMaintenance()).toMatchObject({ reopened: 1, expired: 0 });
    expect(await appOf(a.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED });
    expect(await rsvpOf(a.rsvp.id)).toMatchObject({ status: RsvpStatus.PENDING_APPROVAL, holdExpiresAt: null });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.REQUESTED);

    // They try again; the hold ends again, now after the offer's own deadline.
    expect(await respondAsApplicant(a.token, "accept")).toMatchObject({ ok: true, paying: true });
    await endHold(order.id);
    await prisma.admissionApplication.update({ where: { id: a.application.id }, data: { respondBy: new Date(Date.now() - 60_000) } });
    expect(await runAdmissionMaintenance()).toMatchObject({ expired: 1 });
    expect(await appOf(a.application.id)).toMatchObject({ status: AdmissionStatus.EXPIRED });
    expect((await rsvpOf(a.rsvp.id)).status).toBe(RsvpStatus.REJECTED);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CANCELLED);
  });

  it("keeps an applying team whose leader's hold ended, with its offer standing", async () => {
    const { event, ticket, ctx } = await createAdmissionEvent({ team: true, price: 99900 });
    const leader = await apply(event, "lead", { ticketTypeId: ticket!.id, team: { mode: "create", name: `Hold team ${paid.suffix.slice(0, 6)}` } });
    await decide(ctx, [leader.application.id], "ACCEPT");
    expect(await respondAsApplicant(leader.token, "accept")).toMatchObject({ ok: true, paying: true });
    const order = await prisma.order.findFirstOrThrow({ where: { teamId: leader.rsvp.teamId! } });
    await endHold(order.id);
    expect(await prisma.team.findUnique({ where: { id: leader.rsvp.teamId! } })).not.toBeNull();
    await runAdmissionMaintenance();
    expect(await prisma.team.findUniqueOrThrow({ where: { id: leader.rsvp.teamId! } })).toMatchObject({ status: RsvpStatus.PENDING_APPROVAL });
    expect(await appOf(leader.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED });
  });

  it("counts offers being paid against the offer capacity, and a live hold keeps its place", async () => {
    const { event, ticket, ctx } = await createAdmissionEvent({ price: 49900, capacity: 1, offerCapacity: 2 });
    const a = await apply(event, "first", { ticketTypeId: ticket!.id });
    const b = await apply(event, "second", { ticketTypeId: ticket!.id });
    const c = await apply(event, "third", { ticketTypeId: ticket!.id });
    await decide(ctx, [a.application.id, b.application.id], "ACCEPT");
    expect(await respondAsApplicant(a.token, "accept")).toMatchObject({ ok: true, paying: true });
    // A (paying) and B (offered) fill the two offers.
    await expect(decide(ctx, [c.application.id], "ACCEPT")).rejects.toThrow(/offers? (is|are) left/);
    // The one place is held by A's payment, so B can't take it now.
    expect(await respondAsApplicant(b.token, "accept")).toMatchObject({ ok: false, error: expect.stringMatching(/free places/) });
    expect((await rsvpOf(b.rsvp.id)).status).toBe(RsvpStatus.PENDING_APPROVAL);
  });
});
