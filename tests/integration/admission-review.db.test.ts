import { AdmissionAssignmentStatus, AdmissionStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => (identity.id ? { user: { id: identity.id } } : null)) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { resolveAdmissionReviewer } from "@/lib/admission/access";
import { editApplicationAnswers } from "@/lib/admission/answers";
import { applyAssignment, previewAssignment } from "@/lib/admission/assignment";
import { draftDecisions, releaseDraftBatch } from "@/lib/admission/decisions";
import { listMyReviews, loadReviewItem, recuse, submitReview } from "@/lib/admission/reviews";
import { appOf, apply, createAdmissionEvent, grantReviewers, organiserCtx, paid, people, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * Reviewing (docs/ADMISSION.md "Reviewers"): seeded, reproducible assignment
 * on the stage's panel with conflicts kept out; coverage before release (or
 * an override); append-only reviews and answer revisions; recusal; and
 * reviewers seeing only their own assignments, behind staff MFA.
 */

beforeAll(() => setUpAdmission("Application reviews"));
afterAll(() => tearDownAdmission());

const reviewerCtx = async (eventId: string, userId: string) => {
  const ctx = await resolveAdmissionReviewer(userId, paid.orgSlug, eventId);
  if (!ctx) throw new Error("no reviewer access");
  return ctx;
};

describe.sequential("application review", () => {
  it("assigns reviewers reproducibly, keeps conflicts out, and needs coverage before release", async () => {
    const { event, ctx } = await createAdmissionEvent();
    await grantReviewers(event, people.r1, people.r2, people.r3);
    const apps = [];
    for (let index = 0; index < 6; index += 1) apps.push(await apply(event, `app${index}`));
    // r3 applied to the event themselves: they review nobody.
    await apply(event, "reviewer-applicant", { userId: people.r3 });
    const stage = await prisma.admissionStage.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
    const input = { stageId: stage.id, perApplication: 2, mode: "replace" as const, strategy: "random" as const, reviewerIds: [people.r1, people.r2, people.r3] };
    const first = await previewAssignment(ctx, input);
    if (!first.ok) throw new Error(first.error);
    const again = await previewAssignment(ctx, { ...input, seed: first.data.seed! });
    expect(again.ok && again.data.fingerprint).toBe(first.data.fingerprint);
    expect(await applyAssignment(ctx, { ...input, fingerprint: first.data.fingerprint })).toMatchObject({ ok: false });
    const applied = await applyAssignment(ctx, { ...input, seed: first.data.seed!, fingerprint: first.data.fingerprint });
    expect(applied).toMatchObject({ ok: true, data: { seed: first.data.seed } });
    const assignments = await prisma.admissionReviewAssignment.findMany({ where: { stageId: stage.id } });
    expect(assignments.some((row) => row.reviewerUserId === people.r3)).toBe(false);
    expect(assignments).toHaveLength(7 * 2);
    expect(await prisma.admissionAssignmentRun.findUniqueOrThrow({ where: { id: applied.ok ? applied.data.runId : "" } })).toMatchObject({ strategy: "RANDOM", seed: first.data.seed, perApplication: 2 });

    // Release without reviews (and no override) is refused; reviews then meet the target.
    const target = apps[0]!.application.id;
    expect(await draftDecisions(ctx, { applicationIds: [target], outcome: "ACCEPT" })).toMatchObject({ ok: true });
    expect(await releaseDraftBatch(ctx)).toMatchObject({ ok: false, error: expect.stringMatching(/short of the stage's reviews/) });
    for (const reviewer of [people.r1, people.r2]) {
      const mine = assignments.find((row) => row.applicationId === target && row.reviewerUserId === reviewer)!;
      expect(await submitReview(await reviewerCtx(event.id, reviewer), mine.id, { answersRevision: 1, scores: { overall: 4 }, notes: "Strong" })).toMatchObject({ ok: true });
    }
    expect(await releaseDraftBatch(ctx)).toMatchObject({ ok: true, data: { ACCEPT: 1 } });
    expect(await appOf(target)).toMatchObject({ status: AdmissionStatus.OFFERED });
  });

  it("keeps reviews and answer revisions append-only; new answers need new reviews", async () => {
    const { event, ctx } = await createAdmissionEvent();
    await grantReviewers(event, people.r1);
    const form = await prisma.eventRegistrationForm.create({ data: { eventId: event.id, fields: { create: [{ key: "why", label: "Why?", type: "TEXT", required: false }] } } });
    const a = await apply(event, "writer");
    const stage = await prisma.admissionStage.findFirstOrThrow({ where: { eventId: event.id } });
    const assignment = await prisma.admissionReviewAssignment.create({ data: { stageId: stage.id, applicationId: a.application.id, reviewerUserId: people.r1 } });
    const r1 = await reviewerCtx(event.id, people.r1);
    expect(await submitReview(r1, assignment.id, { answersRevision: 1, scores: { overall: 9 }, notes: "" })).toMatchObject({ ok: false });
    expect(await submitReview(r1, assignment.id, { answersRevision: 1, scores: { overall: 3 }, notes: "" })).toMatchObject({ ok: true });
    expect(await submitReview(r1, assignment.id, { answersRevision: 1, scores: { overall: 5 }, notes: "" })).toMatchObject({ ok: false });
    await expect(prisma.admissionReview.updateMany({ where: { assignmentId: assignment.id }, data: { notes: "rewritten" } })).rejects.toThrow(/append-only/);

    expect(await editApplicationAnswers(a.token, { why: "Because" })).toEqual({ ok: true });
    const revisions = await prisma.admissionAnswerRevision.findMany({ where: { applicationId: a.application.id } });
    expect(revisions).toHaveLength(1);
    await expect(prisma.admissionAnswerRevision.update({ where: { id: revisions[0]!.id }, data: { answers: [{ fieldId: "x", label: "Rewritten", value: "y" }] } })).rejects.toThrow(/append-only/);
    expect(await appOf(a.application.id)).toMatchObject({ answersRevision: 2 });
    expect((await prisma.admissionReviewAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).status).toBe(AdmissionAssignmentStatus.ASSIGNED);
    // The old review no longer counts, so the decision needs a fresh one (or an override).
    expect(await draftDecisions(ctx, { applicationIds: [a.application.id], outcome: "REJECT" })).toMatchObject({ ok: true });
    expect(await releaseDraftBatch(ctx)).toMatchObject({ ok: false });
    expect(await submitReview(r1, assignment.id, { answersRevision: 2, scores: { overall: 2 }, notes: "" })).toMatchObject({ ok: true });
    expect(await releaseDraftBatch(ctx)).toMatchObject({ ok: true });
    // Decided: the answers are locked.
    expect(await editApplicationAnswers(a.token, { why: "Changed my mind" })).toMatchObject({ ok: false });
    expect(form.id).toBeTruthy();
  });

  it("replaces a reviewer who steps back, and shows reviewers only their own work behind MFA", async () => {
    const { event } = await createAdmissionEvent();
    await grantReviewers(event, people.r1, people.r2);
    await prisma.admissionStage.updateMany({ where: { eventId: event.id }, data: { blindReview: true } });
    const a = await apply(event, "blind");
    const stage = await prisma.admissionStage.findFirstOrThrow({ where: { eventId: event.id } });
    const mine = await prisma.admissionReviewAssignment.create({ data: { stageId: stage.id, applicationId: a.application.id, reviewerUserId: people.r1 } });

    const r1 = await reviewerCtx(event.id, people.r1);
    const r2 = await reviewerCtx(event.id, people.r2);
    const item = await loadReviewItem(r1, mine.id);
    expect(item).toMatchObject({ blind: true, teamName: null });
    expect(item!.people[0]).toMatchObject({ name: "Applicant 1", email: null });
    expect(await loadReviewItem(r2, mine.id)).toBeNull();
    expect(await submitReview(r2, mine.id, { answersRevision: 1, scores: { overall: 3 }, notes: "" })).toMatchObject({ ok: false });
    expect(await resolveAdmissionReviewer(people.outsider, paid.orgSlug, event.id)).toBeNull();

    expect(await recuse(r1, mine.id)).toMatchObject({ ok: true, data: { replacedBy: true } });
    expect(await listMyReviews(r1)).toHaveLength(0);
    expect(await listMyReviews(r2)).toHaveLength(1);
    expect(await prisma.admissionReviewConflict.count({ where: { reviewerUserId: people.r1, applicationId: a.application.id } })).toBe(1);

    // Staff MFA: a signed-in reviewer without an authenticator gets no access.
    vi.stubEnv("STAFF_MFA_REQUIRED", "true");
    identity.id = people.r2;
    try {
      expect(await resolveAdmissionReviewer(people.r2, paid.orgSlug, event.id)).toBeNull();
    } finally {
      identity.id = "";
      vi.stubEnv("STAFF_MFA_REQUIRED", "false");
    }
    expect(organiserCtx(event).isAdmin).toBe(true);
  });
});
