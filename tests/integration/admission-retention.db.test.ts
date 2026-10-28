import { AdmissionStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { draftDecisions, releaseDraftBatch } from "@/lib/admission/decisions";
import { promoteWaitlisted } from "@/lib/admission/promotion";
import { respondAsApplicant } from "@/lib/admission/respond";
import { submitReview } from "@/lib/admission/reviews";
import { unassignReviewer } from "@/lib/admission/assignment";
import { editApplicationAnswers } from "@/lib/admission/answers";
import { updateStage } from "@/lib/admission/stages";
import { ALREADY_APPLIED, TEAM_APPLICATION_DECIDED } from "@/lib/admission/registration";
import { appOf, apply, createAdmissionEvent, decide, grantReviewers, paid, people, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * Applications keep their history (docs/ADMISSION.md "Retention"): a deleted
 * registration withdraws and detaches its application with its reviews,
 * decisions and answer revisions intact; nobody applies twice; nothing is
 * created confirmed; decided teams take nobody new; no offers after the
 * start; stages with reviews keep their rubric; reviewed assignments stay.
 */

beforeAll(() => setUpAdmission("Application retention"));
afterAll(() => tearDownAdmission());

const reviewCtx = (eventId: string, organisationId: string, userId: string) => ({ userId, organisationId, orgSlug: paid.orgSlug, eventId, eventSlug: "", isAdmin: false });

describe.sequential("application retention", () => {
  it("keeps a cancelled applicant's application, reviews, decision and answers, and refuses a second application", async () => {
    const { event, ctx } = await createAdmissionEvent();
    await grantReviewers(event, people.r1);
    await prisma.eventRegistrationForm.create({ data: { eventId: event.id, fields: { create: [{ key: "why", label: "Why?", type: "TEXT" }] } } });
    const a = await apply(event, "leaver");
    const stage = await prisma.admissionStage.findFirstOrThrow({ where: { eventId: event.id } });
    const assignment = await prisma.admissionReviewAssignment.create({ data: { stageId: stage.id, applicationId: a.application.id, reviewerUserId: people.r1 } });
    expect(await editApplicationAnswers(a.token, { why: "First" })).toEqual({ ok: true });
    expect(await submitReview(reviewCtx(event.id, event.organisationId, people.r1), assignment.id, { scores: { overall: 3 }, notes: "" })).toMatchObject({ ok: true });
    await decide(ctx, [a.application.id], "WAITLIST");
    // Unassigning a reviewed assignment is refused; the review stays either way.
    expect(await unassignReviewer(ctx, assignment.id)).toMatchObject({ ok: false });

    // The applicant cancels: the registration goes, the application stays as WITHDRAWN.
    await prisma.rSVP.delete({ where: { id: a.rsvp.id } });
    const kept = await appOf(a.application.id);
    expect(kept).toMatchObject({ status: AdmissionStatus.WITHDRAWN, rsvpId: null, subjectName: "leaver Person" });
    expect(await prisma.admissionReview.count({ where: { applicationId: a.application.id } })).toBe(1);
    expect(await prisma.admissionDecision.count({ where: { applicationId: a.application.id } })).toBe(1);
    expect(await prisma.admissionAnswerRevision.count({ where: { applicationId: a.application.id } })).toBe(1);
    await expect(prisma.admissionReview.deleteMany({ where: { applicationId: a.application.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.admissionApplication.delete({ where: { id: a.application.id } })).rejects.toThrow(/kept/);
    expect(await prisma.admissionStatusEvent.count({ where: { applicationId: a.application.id, status: AdmissionStatus.WITHDRAWN } })).toBe(1);

    // Re-registering with the same address is refused: one application per person.
    const again = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: a.email, name: "Again", answers: {} }, { userId: null });
    expect(again).toMatchObject({ ok: false, error: ALREADY_APPLIED });
  });

  it("refuses places created confirmed, and lets the event go with its history", async () => {
    const { event } = await createAdmissionEvent();
    await expect(prisma.rSVP.create({ data: { eventId: event.id, guestEmail: `vip-${paid.suffix}@example.test`, attendeeKey: `guest:vip-${paid.suffix}@example.test`, status: RsvpStatus.CONFIRMED } })).rejects.toThrow(/admission_review_required/);
    const a = await apply(event, "history");
    await prisma.admissionAnswerRevision.create({ data: { applicationId: a.application.id, rsvpId: a.rsvp.id, answersRevision: 1, answers: [] } });
    await prisma.event.delete({ where: { id: event.id } });
    expect(await prisma.admissionApplication.count({ where: { id: a.application.id } })).toBe(0);
  });

  it("takes nobody new into a decided team, and nobody whose own application is closed", async () => {
    const { event, ctx } = await createAdmissionEvent({ team: true });
    const leader = await apply(event, "lead", { team: { mode: "create", name: `Closed ${paid.suffix.slice(0, 6)}` } });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: leader.rsvp.teamId! } });
    expect(leader.application.applicantKeys).toEqual([leader.rsvp.attendeeKey]);
    await decide(ctx, [leader.application.id], "ACCEPT");
    const late = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: `late-${paid.suffix}@example.test`, name: "Late", answers: {} }, { userId: null, team: { mode: "join", joinToken: team.joinToken } });
    expect(late).toMatchObject({ ok: false, error: TEAM_APPLICATION_DECIDED });
    const solo = await apply(event, "rejected-solo");
    await decide(ctx, [solo.application.id], "REJECT");
    await expect(prisma.rSVP.update({ where: { id: solo.rsvp.id }, data: { teamId: team.id } })).rejects.toThrow(/admission_team_closed/);
  });

  it("makes no offers once the event has started", async () => {
    const { event, ctx } = await createAdmissionEvent();
    const a = await apply(event, "late-offer");
    const b = await apply(event, "late-wait");
    await decide(ctx, [b.application.id], "WAITLIST");
    await prisma.event.update({ where: { id: event.id }, data: { startDateTime: new Date(Date.now() - 60_000) } });
    expect(await draftDecisions(ctx, { applicationIds: [a.application.id], outcome: "ACCEPT", overrideReason: "x" })).toMatchObject({ ok: true });
    expect(await releaseDraftBatch(ctx)).toMatchObject({ ok: false, error: expect.stringContaining("started") });
    expect(await promoteWaitlisted(event.id)).toBe(0);
    expect(await appOf(b.application.id)).toMatchObject({ status: AdmissionStatus.WAITLISTED });
  });

  it("keeps a stage's rubric once it has reviews", async () => {
    const { event, ctx } = await createAdmissionEvent();
    await grantReviewers(event, people.r2);
    const a = await apply(event, "rubric");
    const stage = await prisma.admissionStage.findFirstOrThrow({ where: { eventId: event.id } });
    const input = { name: "Review", reviewsPerApplication: 1, blindReview: false, criteria: [], guidance: "", opensAt: null, closesAt: null, status: "OPEN" as const };
    expect(await updateStage(ctx, stage.id, { ...input, criteria: ["Fit"] })).toMatchObject({ ok: true });
    const assignment = await prisma.admissionReviewAssignment.create({ data: { stageId: stage.id, applicationId: a.application.id, reviewerUserId: people.r2 } });
    expect(await submitReview(reviewCtx(event.id, event.organisationId, people.r2), assignment.id, { scores: { Fit: 4 }, notes: "" })).toMatchObject({ ok: true });
    expect(await updateStage(ctx, stage.id, { ...input, criteria: ["Fit", "Impact"] })).toMatchObject({ ok: false });
    expect(await updateStage(ctx, stage.id, { ...input, criteria: ["Fit"], name: "Screening" })).toMatchObject({ ok: true });
    // A withdrawn applicant's offer path is closed too.
    expect(await respondAsApplicant(a.token, "withdraw")).toMatchObject({ ok: true });
  });
});
