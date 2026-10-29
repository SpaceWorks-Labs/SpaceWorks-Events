import { JudgingStatus, RegistrationMode, SubmissionStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { createEventAward, loadEntrantSubmission, publishResults, saveSubmissionDraft, setAwardWinner, setJudgingStatus, submitSubmission, unpublishResults, withdrawSubmission } from "@/lib/core/judging";
import { RESULTS_PUBLISHED } from "@/lib/core/judging/shared";
import { content, createEvent, criterion, openWindow, organiser, register, setUpJudgingSuite, soloAuth, submissionIdFor, tearDownJudgingSuite } from "./helpers/judging";

// docs/HACKATHON.md "Results": published results freeze every project, even while the submission window is open.
describe.sequential("published results freeze projects", () => {
  beforeAll(setUpJudgingSuite);
  afterAll(tearDownJudgingSuite);

  it("refuses edits and withdrawal once results are published, and allows them before", async () => {
    const event = await createEvent({ registrationMode: RegistrationMode.INDIVIDUAL });
    const ctx = await organiser(event);
    await openWindow(ctx);
    const solo = await register(event, "frozen");
    const entrant = await soloAuth(solo.rsvpId, event.id);

    // Before publication: save, submit and edit as usual.
    expect(await saveSubmissionDraft(entrant, content)).toMatchObject({ ok: true });
    expect(await submitSubmission(entrant, content)).toMatchObject({ ok: true, data: { status: SubmissionStatus.SUBMITTED } });
    expect(await loadEntrantSubmission(entrant)).toMatchObject({ canEdit: true });
    const submissionId = await submissionIdFor({ rsvpId: solo.rsvpId });

    await criterion(ctx, { name: "Impact", weight: 1, maxScore: 10 });
    expect(await setJudgingStatus(ctx, JudgingStatus.OPEN)).toMatchObject({ ok: true });
    expect(await setJudgingStatus(ctx, JudgingStatus.CLOSED)).toMatchObject({ ok: true });
    const award = await createEventAward(ctx, { name: "Overall", description: "" });
    if (!award.ok) throw new Error(award.error);
    expect(await setAwardWinner(ctx, { awardId: award.data.id, submissionId, place: 1 })).toMatchObject({ ok: true });
    expect(await publishResults(ctx)).toMatchObject({ ok: true });

    // Published, with the window still open: nothing changes, and the award stays.
    expect(await saveSubmissionDraft(entrant, { ...content, title: "Rewritten" })).toEqual({ ok: false, error: RESULTS_PUBLISHED });
    expect(await submitSubmission(entrant, { ...content, title: "Rewritten" })).toEqual({ ok: false, error: RESULTS_PUBLISHED });
    expect(await withdrawSubmission(entrant)).toEqual({ ok: false, error: RESULTS_PUBLISHED });
    expect(await loadEntrantSubmission(entrant)).toMatchObject({ canEdit: false, window: { isOpen: true } });
    expect(await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } })).toMatchObject({ title: content.title, status: SubmissionStatus.SUBMITTED });
    expect(await prisma.eventAwardWinner.count({ where: { submissionId } })).toBe(1);

    // Unpublished again: the entrant may change the project.
    expect(await unpublishResults(ctx)).toMatchObject({ ok: true });
    expect(await loadEntrantSubmission(entrant)).toMatchObject({ canEdit: true });
    expect(await withdrawSubmission(entrant)).toMatchObject({ ok: true, data: { status: SubmissionStatus.WITHDRAWN } });
  });
});
