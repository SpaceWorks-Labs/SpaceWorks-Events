import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { resolveAdmissionReviewer } from "@/lib/admission/access";
import { applyAssignment, assignReviewer, previewAssignment } from "@/lib/admission/assignment";
import { loadReviewItem, submitReview } from "@/lib/admission/reviews";
import { createStage, updateStage } from "@/lib/admission/stages";
import { apply, createAdmissionEvent, decide, grantReviewers, paid, people, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * Fresh eyes (docs/ADMISSION.md "Reviewers"): on a stage with `freshEyes`,
 * nobody reviews an application they reviewed in an earlier stage: BALANCED
 * and RANDOM assignment, manual assign, the review page and submitting all
 * respect it. The option is fixed once the stage leaves DRAFT.
 */

beforeAll(() => setUpAdmission("Fresh eyes"));
afterAll(() => tearDownAdmission());

const reviewerCtx = async (eventId: string, userId: string) => {
  const ctx = await resolveAdmissionReviewer(userId, paid.orgSlug, eventId);
  if (!ctx) throw new Error("no reviewer access");
  return ctx;
};
const stageInput = { name: "Interview", reviewsPerApplication: 1, blindReview: false, criteria: [], guidance: "", opensAt: null, closesAt: null };
const pairs = (rows: Array<{ reviewerUserId: string; applicationId: string }>) => rows.map((row) => `${row.reviewerUserId}:${row.applicationId}`).sort();

describe.sequential("fresh-eyes admission stages", () => {
  it("never gives an application to someone who reviewed it in an earlier stage", async () => {
    const { event, ctx } = await createAdmissionEvent();
    await grantReviewers(event, people.r1, people.r2);
    const a = await apply(event, "ada");
    const b = await apply(event, "bo");
    const first = await prisma.admissionStage.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
    // Stage 1: r1 reviews Ada, r2 reviews Bo.
    for (const [reviewer, app] of [[people.r1, a], [people.r2, b]] as const) {
      const assignment = await prisma.admissionReviewAssignment.create({ data: { stageId: first.id, applicationId: app.application.id, reviewerUserId: reviewer } });
      expect(await submitReview(await reviewerCtx(event.id, reviewer), assignment.id, { answersRevision: 1, scores: { overall: 4 }, notes: "" })).toMatchObject({ ok: true });
    }
    const created = await createStage(ctx, { ...stageInput, freshEyes: true });
    if (!created.ok) throw new Error(created.error);
    const second = created.data.id;
    expect(await prisma.admissionStage.findUniqueOrThrow({ where: { id: second } })).toMatchObject({ freshEyes: true, status: "DRAFT" });
    await decide(ctx, [a.application.id, b.application.id], "ADVANCE");

    // RANDOM and BALANCED both swap the reviewers: the only fresh pairs.
    const fresh = [`${people.r1}:${b.application.id}`, `${people.r2}:${a.application.id}`].sort();
    const input = { stageId: second, perApplication: 1, mode: "replace" as const, reviewerIds: [people.r1, people.r2] };
    for (let roll = 0; roll < 3; roll += 1) {
      const random = await previewAssignment(ctx, { ...input, strategy: "random" });
      expect(random).toMatchObject({ ok: true, data: { covered: 2, added: 2, shortfalls: [] } });
    }
    const balanced = await previewAssignment(ctx, { ...input, strategy: "balanced" });
    if (!balanced.ok) throw new Error(balanced.error);
    expect(await applyAssignment(ctx, { ...input, strategy: "balanced", fingerprint: balanced.data.fingerprint })).toMatchObject({ ok: true, data: { added: 2 } });
    expect(pairs(await prisma.admissionReviewAssignment.findMany({ where: { stageId: second } }))).toEqual(fresh);

    // Asking for two reviews each leaves a shortfall rather than reusing an earlier reviewer.
    const short = await previewAssignment(ctx, { ...input, perApplication: 2, mode: "keep", strategy: "balanced" });
    expect(short.ok && short.data.shortfalls.length).toBe(2);
    expect(short.ok && short.data.added).toBe(0);

    // Manual assign, the review page and submitting refuse the earlier reviewer too.
    expect(await assignReviewer(ctx, { stageId: second, applicationId: a.application.id, reviewerUserId: people.r1 })).toMatchObject({ ok: false, error: expect.stringContaining("earlier stage") });
    expect(await updateStage(ctx, second, { ...stageInput, freshEyes: true, status: "OPEN" })).toEqual({ ok: true, data: undefined });
    const stale = await prisma.admissionReviewAssignment.create({ data: { stageId: second, applicationId: a.application.id, reviewerUserId: people.r1 } });
    const r1 = await reviewerCtx(event.id, people.r1);
    expect(await loadReviewItem(r1, stale.id)).toBeNull();
    expect(await submitReview(r1, stale.id, { answersRevision: 1, scores: { overall: 5 }, notes: "" })).toMatchObject({ ok: false, error: expect.stringContaining("earlier stage") });
    const own = await prisma.admissionReviewAssignment.findFirstOrThrow({ where: { stageId: second, reviewerUserId: people.r1, applicationId: b.application.id } });
    expect(await submitReview(r1, own.id, { answersRevision: 1, scores: { overall: 5 }, notes: "" })).toMatchObject({ ok: true });
  });

  it("lets the option change only while the stage is a draft with no assignments or reviews", async () => {
    const { event, ctx } = await createAdmissionEvent();
    await grantReviewers(event, people.r1);
    const created = await createStage(ctx, stageInput);
    if (!created.ok) throw new Error(created.error);
    const stageId = created.data.id;
    expect(await prisma.admissionStage.findUniqueOrThrow({ where: { id: stageId } })).toMatchObject({ freshEyes: false });
    expect(await updateStage(ctx, stageId, { ...stageInput, freshEyes: true, status: "DRAFT" })).toMatchObject({ ok: true });
    expect(await updateStage(ctx, stageId, { ...stageInput, freshEyes: false, status: "DRAFT" })).toMatchObject({ ok: true });
    // Turning it on while opening the stage is allowed; after that it is fixed.
    expect(await updateStage(ctx, stageId, { ...stageInput, freshEyes: true, status: "OPEN" })).toMatchObject({ ok: true });
    expect(await updateStage(ctx, stageId, { ...stageInput, freshEyes: false, status: "OPEN" })).toMatchObject({ ok: false, error: expect.stringContaining("Fresh eyes") });
    expect(await updateStage(ctx, stageId, { ...stageInput, freshEyes: false, status: "DRAFT" })).toMatchObject({ ok: false });
    // Omitted: unchanged, and other fields still save.
    expect(await updateStage(ctx, stageId, { ...stageInput, name: "Renamed", status: "OPEN" })).toMatchObject({ ok: true });
    expect(await prisma.admissionStage.findUniqueOrThrow({ where: { id: stageId } })).toMatchObject({ freshEyes: true, name: "Renamed" });
  });
});
