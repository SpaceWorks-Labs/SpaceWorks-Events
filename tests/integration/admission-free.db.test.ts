import { AdmissionStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { runAdmissionMaintenance } from "@/lib/admission/maintenance";
import { respondAsApplicant } from "@/lib/admission/respond";
import { applicationReachedStage, createStage } from "@/lib/admission/stages";
import { appOf, apply, createAdmissionEvent, decide, noticesFor, rsvpOf, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * Applications on a free, ordinary event (docs/ADMISSION.md): no hackathon,
 * no tickets, no money anywhere. Apply, move through stages, offer, accept
 * (confirmed at once with the ticket email), decline, expire, and the
 * waitlist taking a freed offer; then a free team event.
 */

const stage2 = { name: "Shortlist", reviewsPerApplication: 1, blindReview: false, criteria: [], guidance: "", opensAt: null, closesAt: null };

beforeAll(() => setUpAdmission("Free applications"));
afterAll(() => tearDownAdmission());

describe.sequential("free applications", () => {
  it("takes applications through a shortlist stage to a confirmed ticket, with no order or hold", async () => {
    const { event, ctx } = await createAdmissionEvent({ capacity: 10 });
    const [a, b, c] = [await apply(event, "ana"), await apply(event, "ben"), await apply(event, "cai")];
    for (const person of [a, b, c]) {
      expect(person.application).toMatchObject({ status: AdmissionStatus.IN_REVIEW, eventId: event.id });
      expect(person.rsvp.status).toBe(RsvpStatus.PENDING_APPROVAL);
    }
    const first = await prisma.admissionStage.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
    expect(await prisma.admissionStageEntry.count({ where: { stageId: first.id } })).toBe(3);

    const created = await createStage(ctx, stage2);
    if (!created.ok) throw new Error(created.error);
    expect(await decide(ctx, [a.application.id, b.application.id], "ADVANCE")).toMatchObject({ ADVANCE: 2 });
    expect(await appOf(a.application.id)).toMatchObject({ currentStageId: created.data.id, status: AdmissionStatus.IN_REVIEW });
    expect(await applicationReachedStage(prisma, { eventId: event.id, stageId: created.data.id, rsvpId: a.rsvp.id })).toBe(true);
    expect(await applicationReachedStage(prisma, { eventId: event.id, stageId: created.data.id, rsvpId: c.rsvp.id })).toBe(false);
    // Stage-advanced email is off by default.
    expect(await noticesFor(a.application.id, "stage-advanced")).toBe(0);

    await decide(ctx, [a.application.id, b.application.id], "ACCEPT");
    expect(await appOf(a.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED, respondBy: expect.any(Date) });
    expect((await rsvpOf(a.rsvp.id)).status).toBe(RsvpStatus.PENDING_APPROVAL);
    expect(await noticesFor(a.application.id, "offer")).toBe(1);

    expect(await respondAsApplicant(a.token, "accept")).toEqual({ ok: true, status: AdmissionStatus.ACCEPTED, paying: false });
    expect((await rsvpOf(a.rsvp.id)).status).toBe(RsvpStatus.CONFIRMED);
    expect(await prisma.outboxMessage.count({ where: { kind: "rsvp-status", payload: { path: ["checkInToken"], equals: a.token } } })).toBe(1);
    expect(await prisma.order.count({ where: { eventId: event.id } })).toBe(0);

    expect(await respondAsApplicant(b.token, "decline")).toMatchObject({ ok: true, status: AdmissionStatus.DECLINED });
    expect((await rsvpOf(b.rsvp.id)).status).toBe(RsvpStatus.REJECTED);
    expect(await respondAsApplicant(b.token, "accept")).toMatchObject({ ok: false });
  });

  it("expires an unanswered offer and offers the freed place to the waitlist, first in first offered", async () => {
    const { event, ctx } = await createAdmissionEvent({ offerCapacity: 1 });
    const x = await apply(event, "xia");
    const y = await apply(event, "yan");
    const z = await apply(event, "zed");
    await decide(ctx, [x.application.id], "ACCEPT");
    // The offers are full: a further offer is refused as a whole.
    await expect(decide(ctx, [y.application.id], "ACCEPT")).rejects.toThrow(/offers? (is|are) left/);
    await prisma.admissionDecisionBatch.updateMany({ where: { eventId: event.id, status: "DRAFT" }, data: { status: "CANCELLED" } });
    await decide(ctx, [y.application.id], "WAITLIST");
    await decide(ctx, [z.application.id], "WAITLIST");
    expect((await rsvpOf(y.rsvp.id)).status).toBe(RsvpStatus.WAITLISTED);

    await prisma.admissionApplication.update({ where: { id: x.application.id }, data: { respondBy: new Date(Date.now() - 60_000) } });
    const pass = await runAdmissionMaintenance();
    expect(pass).toMatchObject({ expired: 1, promoted: 1 });
    expect(await appOf(x.application.id)).toMatchObject({ status: AdmissionStatus.EXPIRED });
    expect((await rsvpOf(x.rsvp.id)).status).toBe(RsvpStatus.REJECTED);
    expect(await noticesFor(x.application.id, "expired")).toBe(1);
    expect(await appOf(y.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED });
    expect(await appOf(z.application.id)).toMatchObject({ status: AdmissionStatus.WAITLISTED });
    expect((await rsvpOf(y.rsvp.id)).status).toBe(RsvpStatus.PENDING_APPROVAL);

    // Withdrawing an offer hands it on as well.
    expect(await respondAsApplicant(y.token, "withdraw")).toMatchObject({ ok: true, status: AdmissionStatus.WITHDRAWN });
    expect(await appOf(z.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED });
  });

  it("admits a free team as a whole: the leader answers and every member is confirmed", async () => {
    const { event, ctx } = await createAdmissionEvent({ team: true, minTeam: 2 });
    const leader = await apply(event, "lead", { team: { mode: "create", name: `Comets ${Date.now()}` } });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: leader.rsvp.teamId! } });
    const member = await apply(event, "member", { team: { mode: "join", joinToken: team.joinToken } });
    expect(member.application.id).toBe(leader.application.id);
    expect(await prisma.admissionApplication.count({ where: { eventId: event.id } })).toBe(1);

    await decide(ctx, [leader.application.id], "ACCEPT");
    expect(await respondAsApplicant(member.token, "accept")).toMatchObject({ ok: false, error: expect.stringContaining("team leader") });
    expect(await respondAsApplicant(leader.token, "accept")).toMatchObject({ ok: true, status: AdmissionStatus.ACCEPTED });
    expect(await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).toMatchObject({ status: RsvpStatus.CONFIRMED });
    expect((await rsvpOf(member.rsvp.id)).status).toBe(RsvpStatus.CONFIRMED);
    expect(await prisma.outboxMessage.count({ where: { kind: "rsvp-status", payload: { path: ["checkInToken"], equals: member.token } } })).toBe(1);
  });
});
