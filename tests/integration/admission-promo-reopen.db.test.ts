import { AdmissionStatus, OrderStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { runAdmissionMaintenance } from "@/lib/admission/maintenance";
import { PROMO_USED_UP } from "@/lib/admission/payment";
import { respondAsApplicant } from "@/lib/admission/respond";
import { runPaymentMaintenance } from "@/lib/payments/maintenance";
import { promoCodeDigest, promoCodeHint } from "@/lib/payments/promo";
import { appOf, apply, createAdmissionEvent, decide, paid, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * An offer whose payment hold ended unpaid stands again (docs/ADMISSION.md
 * "Paid places"), but its order only takes its promo code back while the code
 * still has a use left: a code used up meanwhile keeps the order EXPIRED.
 */

beforeAll(() => setUpAdmission("Application promo reopen"));
afterAll(() => tearDownAdmission());

describe.sequential("reopening an ended hold with a promo code", () => {
  it("keeps the order expired, and refuses accepting again, once its code was used up by someone else", async () => {
    const { event, ticket, ctx } = await createAdmissionEvent({ price: 49900 });
    const code = `ONCE-${paid.suffix.slice(0, 8)}`.toUpperCase();
    const promo = await prisma.promoCode.create({ data: { eventId: event.id, codeDigest: promoCodeDigest(code), hint: promoCodeHint(code), kind: "PERCENT", percentOff: 50, maxRedemptions: 1 } });
    const a = await apply(event, "first", { ticketTypeId: ticket!.id });
    const first = await prisma.order.update({ where: { id: a.rsvp.orderId! }, data: { promoCodeId: promo.id } });
    await decide(ctx, [a.application.id], "ACCEPT");
    expect(await respondAsApplicant(a.token, "accept")).toMatchObject({ ok: true, paying: true });

    // The hold ends unpaid, freeing the code's one use; another applicant's request takes it.
    const past = new Date(Date.now() - 1000);
    await prisma.order.update({ where: { id: first.id }, data: { holdExpiresAt: past } });
    await prisma.rSVP.updateMany({ where: { orderId: first.id }, data: { holdExpiresAt: past } });
    await runPaymentMaintenance();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(OrderStatus.EXPIRED);
    const b = await apply(event, "second", { ticketTypeId: ticket!.id });
    await prisma.order.update({ where: { id: b.rsvp.orderId! }, data: { promoCodeId: promo.id } });

    expect(await runAdmissionMaintenance()).toMatchObject({ reopened: 0, expired: 0 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(OrderStatus.EXPIRED);
    expect(await appOf(a.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED });
    expect(await respondAsApplicant(a.token, "accept")).toEqual({ ok: false, error: PROMO_USED_UP });
    expect(await prisma.order.count({ where: { promoCodeId: promo.id, status: { in: [OrderStatus.REQUESTED, OrderStatus.PENDING, OrderStatus.CONFIRMED] } } })).toBe(1);

    // Once the other request lets the code go, the offer can be paid again.
    await prisma.order.update({ where: { id: b.rsvp.orderId! }, data: { promoCodeId: null } });
    expect(await runAdmissionMaintenance()).toMatchObject({ reopened: 1 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(OrderStatus.REQUESTED);
  });
});
