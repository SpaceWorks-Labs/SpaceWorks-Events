import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => (session.userId ? { user: { id: session.userId } } : null)) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined, updateTag: () => undefined }));

import { prisma } from "@/lib/db";
import { deleteReimbursementPolicyAction, saveReimbursementPolicyAction } from "@/app/actions/finance";
import { deleteEvent } from "@/app/actions/event/remove";
import { deletePolicy, savePolicy, setPolicyActive } from "@/lib/claims/policies/manage";
import { submitParticipantClaim } from "@/lib/claims/submit";
import { deleteJudgingRound } from "@/lib/core/judging/rounds/manage";
import { admin, claimInput, ctx, finalsRound, freeEvent, mentoringRound, person, policy, setUpReimbursements, tearDownReimbursements } from "./helpers/reimbursements";

/*
 * docs/FINANCE.md "Reimbursement policies": owners and admins manage
 * policies of their own events only; the stage must match the kind and the
 * event (also enforced by CHECK and trigger); who a policy is for is fixed
 * once claimed; a claimed policy is closed, never deleted; deleting the
 * event or the organisation still works.
 */

const base = { name: "Travel", eligibility: "CONFIRMED_PARTICIPANT", cap: "1000", categories: ["TRAVEL"] };
const scope = (event: { id: string }) => ({ organisationSlug: `reimbadmin-${ctx.suffix}`, eventId: event.id });

beforeAll(() => setUpReimbursements("ReimbAdmin"));
afterAll(() => tearDownReimbursements());

describe.sequential("managing reimbursement policies", () => {
  it("allows owners and admins only, on their own organisation's events", async () => {
    const event = await freeEvent();
    session.userId = ctx.memberId;
    expect(await saveReimbursementPolicyAction(scope(event), base)).toMatchObject({ ok: false, error: expect.stringContaining("owners and admins") });
    session.userId = null;
    expect(await saveReimbursementPolicyAction(scope(event), base)).toMatchObject({ ok: false });
    expect(await savePolicy(admin(event, ctx.otherOrganisationId), base)).toMatchObject({ ok: false, error: "Event not found." });
    const otherEvent = await freeEvent(ctx.otherOrganisationId);
    expect(await savePolicy({ ...admin(otherEvent), organisationId: ctx.organisationId }, base)).toMatchObject({ ok: false, error: "Event not found." });
    expect(await prisma.reimbursementPolicy.count({ where: { eventId: { in: [event.id, otherEvent.id] } } })).toBe(0);
  });

  it("checks the stage against the kind and the event, in code and in the database", async () => {
    const event = await freeEvent();
    const elsewhere = await freeEvent();
    const finals = await finalsRound(event);
    const firstRound = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
    const foreignRound = await finalsRound(elsewhere);
    const mentoring = await mentoringRound(event);
    const judging = { ...base, eligibility: "JUDGING_ROUND_ENTRY" };
    expect(await savePolicy(admin(event), judging)).toMatchObject({ ok: false, error: "Choose the judging round." });
    expect(await savePolicy(admin(event), { ...judging, judgingRoundId: firstRound.id })).toMatchObject({ ok: false, error: expect.stringContaining("advanced") });
    expect(await savePolicy(admin(event), { ...judging, judgingRoundId: foreignRound.id })).toMatchObject({ ok: false });
    const saved = await savePolicy(admin(event), { ...judging, judgingRoundId: finals.id, mentoringRoundId: mentoring.id });
    expect(saved).toMatchObject({ ok: true });
    expect(await prisma.reimbursementPolicy.findFirstOrThrow({ where: { eventId: event.id } })).toMatchObject({ judgingRoundId: finals.id, mentoringRoundId: null });
    expect(await savePolicy(admin(event), { ...base, claimOpensAt: "2030-01-02T10:00", claimClosesAt: "2030-01-01T10:00" })).toMatchObject({ ok: false, error: expect.stringContaining("close after") });
    expect(await savePolicy(admin(event), { ...base, categories: [] })).toMatchObject({ ok: false });
    expect(await savePolicy(admin(event), { ...base, cap: "0" })).toMatchObject({ ok: false });

    const row = { eventId: event.id, name: "Raw", capPerPersonMinor: BigInt(100), categories: ["TRAVEL" as const] };
    await expect(prisma.reimbursementPolicy.create({ data: { ...row, eligibility: "JUDGING_ROUND_ENTRY" } })).rejects.toThrow();
    await expect(prisma.reimbursementPolicy.create({ data: { ...row, eligibility: "CREW", judgingRoundId: finals.id } })).rejects.toThrow();
    await expect(prisma.reimbursementPolicy.create({ data: { ...row, eligibility: "JUDGING_ROUND_ENTRY", judgingRoundId: foreignRound.id } })).rejects.toThrow(/another event/);
    await expect(prisma.reimbursementPolicy.create({ data: { ...row, eligibility: "CREW", requireFinalistsPublished: true } })).rejects.toThrow();
    // A claim's policy belongs to the claim's event.
    const otherPolicy = await policy(elsewhere);
    await expect(prisma.expenseClaim.create({ data: {
      organisationId: ctx.organisationId, eventId: event.id, eventTitle: "x", kind: "PARTICIPANT", payeeName: "x", payeeEmail: "x@example.test", category: "TRAVEL",
      description: "x", amountMinor: BigInt(1), currency: "INR", policyId: otherPolicy, eligibilitySnapshot: {},
    } })).rejects.toThrow(/another event/);
  });

  it("fixes who a policy is for once claimed, closes instead of deleting, and guards its round", async () => {
    const event = await freeEvent();
    const finals = await finalsRound(event);
    const unused = await policy(event, { name: "Unused" });
    const used = await policy(event, { name: "Finalists", eligibility: "JUDGING_ROUND_ENTRY", judgingRoundId: finals.id });
    const general = await policy(event, { name: "Everyone" });
    const ivy = await person(event);
    expect(await submitParticipantClaim({ ticketToken: ivy.checkInToken, actorUserId: null }, claimInput("100", general), [])).toMatchObject({ ok: true });

    expect(await savePolicy(admin(event), { ...base, policyId: general, name: "Renamed", cap: "2000" })).toMatchObject({ ok: true });
    expect(await savePolicy(admin(event), { ...base, policyId: general, eligibility: "CREW" })).toMatchObject({ ok: false, error: expect.stringContaining("fixed once claims") });
    expect(await deletePolicy(admin(event), general)).toMatchObject({ ok: false, error: expect.stringContaining("only be closed") });
    await expect(prisma.reimbursementPolicy.delete({ where: { id: general } })).rejects.toThrow();
    expect(await setPolicyActive(admin(event), { policyId: general, active: false })).toMatchObject({ ok: true });
    expect(await submitParticipantClaim({ ticketToken: ivy.checkInToken, actorUserId: null }, claimInput("100", general), [])).toMatchObject({ ok: false });

    session.userId = ctx.ownerId;
    expect(await deleteReimbursementPolicyAction(scope(event), unused)).toEqual({ ok: true });
    const organiserCtx = { userId: ctx.ownerId, organisationId: ctx.organisationId, eventId: event.id } as Parameters<typeof deleteJudgingRound>[0];
    expect(await deleteJudgingRound(organiserCtx, finals.id)).toMatchObject({ ok: false, error: expect.stringContaining("reimbursement policy") });
    expect(await deletePolicy(admin(event), used)).toMatchObject({ ok: true });
    expect(await prisma.auditEvent.count({ where: { targetType: "ReimbursementPolicy", targetId: { in: [unused, used, general] } } })).toBeGreaterThanOrEqual(6);
  });

  it("keeps claims when the event is deleted, and lets the organisation be deleted with its policies", async () => {
    const event = await freeEvent();
    const travel = await policy(event);
    const jo = await person(event);
    expect(await submitParticipantClaim({ ticketToken: jo.checkInToken, actorUserId: null }, claimInput("100", travel), [])).toMatchObject({ ok: true });
    session.userId = ctx.ownerId;
    expect(await deleteEvent({ organisationSlug: `reimbadmin-${ctx.suffix}`, eventId: event.id })).toMatchObject({ ok: true });
    const kept = await prisma.expenseClaim.findFirstOrThrow({ where: { eventTitle: event.title, organisationId: ctx.organisationId } });
    expect(kept).toMatchObject({ eventId: null, policyId: null });
    expect(kept.eligibilitySnapshot).toMatchObject({ terms: { policyId: travel } });

    const doomed = await prisma.organisation.create({ data: { name: "Doomed", slug: `doomed-${ctx.suffix}` } });
    const doomedEvent = await freeEvent(doomed.id);
    const doomedPolicy = await savePolicy(admin(doomedEvent, doomed.id), base);
    const kim = await person(doomedEvent);
    expect(await submitParticipantClaim({ ticketToken: kim.checkInToken, actorUserId: null }, claimInput("100", doomedPolicy.ok ? doomedPolicy.data.policyId : ""), [])).toMatchObject({ ok: true });
    await prisma.organisation.delete({ where: { id: doomed.id } });
    expect(await prisma.reimbursementPolicy.count({ where: { eventId: doomedEvent.id } })).toBe(0);
  });
});
