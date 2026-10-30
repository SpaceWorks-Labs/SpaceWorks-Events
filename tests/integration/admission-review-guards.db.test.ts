import { AdmissionStageStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => (identity.id ? { user: { id: identity.id } } : null)) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { submitApplicationReview } from "@/app/actions/admission-applicant";
import { resolveAdmissionReviewer } from "@/lib/admission/access";
import { editApplicationAnswers } from "@/lib/admission/answers";
import { applyAssignment, previewAssignment, type AssignInput } from "@/lib/admission/assignment";
import { listMyReviews, loadReviewItem, STALE_ANSWERS, submitReview } from "@/lib/admission/reviews";
import { submitMyReview } from "@/lib/mobile/admission";
import { apply, createAdmissionEvent, grantReviewers, paid, people, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * Review guards (docs/ADMISSION.md "Reviewers"): a review of answers that
 * changed since the reviewer loaded them is refused (web and mobile); the
 * review target is frozen once the stage has a review, assignment included;
 * and the queue lists only what the reviewer may still read.
 */

beforeAll(() => setUpAdmission("Application review guards"));
afterAll(() => tearDownAdmission());

const reviewerCtx = async (eventId: string, userId: string) => {
  const ctx = await resolveAdmissionReviewer(userId, paid.orgSlug, eventId);
  if (!ctx) throw new Error("no reviewer access");
  return ctx;
};

describe.sequential("application review guards", () => {
  it("refuses a review of answers that changed since they were loaded, on the web and on mobile", async () => {
    const { event } = await createAdmissionEvent();
    await grantReviewers(event, people.r1);
    await prisma.eventRegistrationForm.create({ data: { eventId: event.id, fields: { create: [{ key: "why", label: "Why?", type: "TEXT", required: false }] } } });
    const a = await apply(event, "changes");
    const b = await apply(event, "steady");
    const stage = await prisma.admissionStage.findFirstOrThrow({ where: { eventId: event.id } });
    const onA = await prisma.admissionReviewAssignment.create({ data: { stageId: stage.id, applicationId: a.application.id, reviewerUserId: people.r1 } });
    const onB = await prisma.admissionReviewAssignment.create({ data: { stageId: stage.id, applicationId: b.application.id, reviewerUserId: people.r1 } });
    const r1 = await reviewerCtx(event.id, people.r1);

    expect(await loadReviewItem(r1, onA.id)).toMatchObject({ answersRevision: 1, canReview: true });
    expect(await editApplicationAnswers(a.token, { why: "Changed after the reviewer opened it" })).toEqual({ ok: true });

    const web = (assignmentId: string, answersRevision: number) => submitApplicationReview({ organisationSlug: paid.orgSlug, eventId: event.id, assignmentId, answersRevision, scores: { overall: 3 }, notes: "" });
    identity.id = people.r1;
    try {
      expect(await web(onA.id, 1)).toEqual({ ok: false, error: STALE_ANSWERS });
      expect(await submitMyReview(r1, onA.id, { answersRevision: 1, scores: { overall: 3 }, notes: "" })).toEqual({ ok: false, error: STALE_ANSWERS });
      expect(await prisma.admissionReview.count({ where: { assignmentId: onA.id } })).toBe(0);

      // Reloaded: the current revision is accepted, on either surface.
      expect(await loadReviewItem(r1, onA.id)).toMatchObject({ answersRevision: 2 });
      expect(await web(onA.id, 2)).toMatchObject({ ok: true });
      expect(await submitMyReview(r1, onB.id, { answersRevision: 1, scores: { overall: 4 }, notes: "" })).toMatchObject({ ok: true, data: { outcome: "SUBMITTED" } });
    } finally {
      identity.id = "";
    }
    expect(await prisma.admissionReview.findFirstOrThrow({ where: { assignmentId: onA.id } })).toMatchObject({ answersRevision: 2 });
  });

  it("keeps the review target once the stage has a review, unless it is unchanged", async () => {
    const { event, ctx } = await createAdmissionEvent();
    await grantReviewers(event, people.r1, people.r2);
    const a = await apply(event, "target-a");
    await apply(event, "target-b");
    const stage = await prisma.admissionStage.findFirstOrThrow({ where: { eventId: event.id } });
    const assign = async (perApplication: number) => {
      const input: AssignInput = { stageId: stage.id, perApplication, mode: "keep", strategy: "balanced", reviewerIds: [people.r1, people.r2] };
      const preview = await previewAssignment(ctx, input);
      if (!preview.ok) throw new Error(preview.error);
      return applyAssignment(ctx, { ...input, fingerprint: preview.data.fingerprint });
    };

    // No reviews yet: the target may change.
    expect(await assign(2)).toMatchObject({ ok: true });
    const mine = await prisma.admissionReviewAssignment.findFirstOrThrow({ where: { stageId: stage.id, applicationId: a.application.id, reviewerUserId: people.r1 } });
    expect(await submitReview(await reviewerCtx(event.id, people.r1), mine.id, { answersRevision: 1, scores: { overall: 4 }, notes: "" })).toMatchObject({ ok: true });

    const runs = await prisma.admissionAssignmentRun.count({ where: { stageId: stage.id } });
    expect(await assign(1)).toEqual({ ok: false, error: expect.stringContaining("already has reviews") });
    expect(await prisma.admissionAssignmentRun.count({ where: { stageId: stage.id } })).toBe(runs);
    expect(await prisma.admissionStage.findUniqueOrThrow({ where: { id: stage.id } })).toMatchObject({ reviewsPerApplication: 2 });
    // The same target is still a valid assignment.
    expect(await assign(2)).toMatchObject({ ok: true });
    expect(await prisma.admissionAssignmentRun.count({ where: { stageId: stage.id } })).toBe(runs + 1);
  });

  it("lists only assignments the reviewer may still read, keeping their submitted reviews", async () => {
    const { event } = await createAdmissionEvent();
    await grantReviewers(event, people.r1, people.r2);
    const a = await apply(event, "conflicted");
    const b = await apply(event, "listed");
    const stage = await prisma.admissionStage.findFirstOrThrow({ where: { eventId: event.id } });
    const onA = await prisma.admissionReviewAssignment.create({ data: { stageId: stage.id, applicationId: a.application.id, reviewerUserId: people.r1 } });
    const onB = await prisma.admissionReviewAssignment.create({ data: { stageId: stage.id, applicationId: b.application.id, reviewerUserId: people.r1 } });
    const r1 = await reviewerCtx(event.id, people.r1);
    expect((await listMyReviews(r1)).map((item) => item.assignmentId).sort()).toEqual([onA.id, onB.id].sort());

    // Off the stage's panel (still a reviewer of the event): nothing from that stage, names included.
    await prisma.admissionStageReviewer.create({ data: { stageId: stage.id, userId: people.r2 } });
    const off = await listMyReviews(r1);
    expect(off).toEqual([]);
    expect(JSON.stringify(off)).not.toContain("conflicted Person");
    await prisma.admissionStageReviewer.deleteMany({ where: { stageId: stage.id } });

    // A conflict hides that application only.
    await prisma.admissionReviewConflict.create({ data: { eventId: event.id, reviewerUserId: people.r1, applicationId: a.application.id, reason: "declared" } });
    const listed = await listMyReviews(r1);
    expect(listed.map((item) => item.assignmentId)).toEqual([onB.id]);
    expect(JSON.stringify(listed)).not.toContain("conflicted Person");

    // A submitted review stays listed once the stage closes: closed isn't unauthorised.
    expect(await submitReview(r1, onB.id, { answersRevision: 1, scores: { overall: 5 }, notes: "" })).toMatchObject({ ok: true });
    await prisma.admissionStage.update({ where: { id: stage.id }, data: { status: AdmissionStageStatus.CLOSED } });
    expect(await listMyReviews(r1)).toEqual([expect.objectContaining({ assignmentId: onB.id, stageOpen: false, reviewedCurrent: true, label: expect.stringContaining("listed Person") })]);
    expect(await loadReviewItem(r1, onB.id)).toMatchObject({ reviewed: { scores: { overall: 5 } }, canReview: false });
  });
});
