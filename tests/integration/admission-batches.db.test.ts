import { AdmissionBatchStatus, AdmissionStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { cancelDraftBatch, draftDecisions, releaseDraftBatch } from "@/lib/admission/decisions";
import { promoteWaitlisted } from "@/lib/admission/promotion";
import { respondAsApplicant } from "@/lib/admission/respond";
import { appOf, apply, createAdmissionEvent, decide, paid, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * Decision batches (docs/ADMISSION.md "Decisions") release or cancel as a
 * whole, and refuse when an application changed since its decision was
 * drafted. The waitlist is offered first in, first offered, passing over
 * applications that can't take a place now (a full ticket type, a team
 * below the minimum size) with the reason kept.
 */

beforeAll(() => setUpAdmission("Application batches"));
afterAll(() => tearDownAdmission());

describe.sequential("decision batches and the waitlist", () => {
  it("releases nothing when one decision is stale, and nothing from a cancelled batch", async () => {
    const { event, ctx } = await createAdmissionEvent();
    const a = await apply(event, "one");
    const b = await apply(event, "two");
    expect(await draftDecisions(ctx, { applicationIds: [a.application.id], outcome: "ACCEPT", overrideReason: "Known speaker" })).toMatchObject({ ok: true });
    expect(await draftDecisions(ctx, { applicationIds: [b.application.id], outcome: "REJECT", overrideReason: "Out of scope" })).toMatchObject({ ok: true });
    // B withdraws after the draft: the batch is stale.
    expect(await respondAsApplicant(b.token, "withdraw")).toMatchObject({ ok: true });
    expect(await releaseDraftBatch(ctx)).toMatchObject({ ok: false, error: expect.stringContaining("changed since") });
    expect(await appOf(a.application.id)).toMatchObject({ status: AdmissionStatus.IN_REVIEW, decisionRevision: 0 });

    expect(await cancelDraftBatch(ctx)).toEqual({ ok: true, data: undefined });
    expect(await prisma.admissionDecisionBatch.findFirstOrThrow({ where: { eventId: event.id } })).toMatchObject({ status: AdmissionBatchStatus.CANCELLED });
    expect(await releaseDraftBatch(ctx)).toMatchObject({ ok: false });
    expect(await appOf(a.application.id)).toMatchObject({ status: AdmissionStatus.IN_REVIEW });

    // A fresh batch works, and a released decision can't be rewritten.
    await decide(ctx, [a.application.id], "ACCEPT");
    const released = await prisma.admissionDecision.findFirstOrThrow({ where: { applicationId: a.application.id, batch: { status: AdmissionBatchStatus.RELEASED } } });
    await expect(prisma.admissionDecision.update({ where: { id: released.id }, data: { note: "changed" } })).rejects.toThrow(/append-only/);
    // Only one draft batch per event.
    await prisma.admissionDecisionBatch.create({ data: { eventId: event.id } });
    await expect(prisma.admissionDecisionBatch.create({ data: { eventId: event.id } })).rejects.toThrow();
  });

  it("offers the waitlist in queue order, passing over a full ticket type", async () => {
    const { event, ticket, ctx } = await createAdmissionEvent({ price: 0, typeCapacity: 1, offerCapacity: 3 });
    const open = await prisma.ticketType.create({ data: { eventId: event.id, name: "Open", priceMinor: BigInt(0), maxPerOrder: 1 } });
    const holder = await apply(event, "holder", { ticketTypeId: ticket!.id });
    const blocked = await apply(event, "blocked", { ticketTypeId: ticket!.id });
    const next = await apply(event, "next", { ticketTypeId: open.id });
    await decide(ctx, [holder.application.id], "ACCEPT");
    expect(await respondAsApplicant(holder.token, "accept")).toMatchObject({ ok: true });
    await decide(ctx, [blocked.application.id], "WAITLIST");
    await decide(ctx, [next.application.id], "WAITLIST");
    expect(await promoteWaitlisted(event.id)).toBe(1);
    expect(await appOf(blocked.application.id)).toMatchObject({ status: AdmissionStatus.WAITLISTED, skipReason: expect.stringContaining("ticket type is full") });
    expect(await appOf(next.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED });
    expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: next.rsvp.id } })).status).toBe(RsvpStatus.PENDING_APPROVAL);
  });

  it("passes over a team below the minimum size until it is complete", async () => {
    const { event, ctx } = await createAdmissionEvent({ team: true, minTeam: 2, offerCapacity: 1 });
    const small = await apply(event, "small", { team: { mode: "create", name: `Small ${paid.suffix.slice(0, 6)}` } });
    const solo = await apply(event, "solo");
    await decide(ctx, [small.application.id], "WAITLIST");
    await decide(ctx, [solo.application.id], "WAITLIST");
    expect(await promoteWaitlisted(event.id)).toBe(1);
    expect(await appOf(small.application.id)).toMatchObject({ status: AdmissionStatus.WAITLISTED, skipReason: expect.stringContaining("fewer than 2") });
    expect(await appOf(solo.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED });
  });
});
