"use server";

import { isActionRateLimited } from "@/lib/actionRateLimit";
import { editApplicationAnswers } from "@/lib/admission/answers";
import { respondAsApplicant } from "@/lib/admission/respond";
import { loadReviewItem, recuse, submitReview, type ReviewItem } from "@/lib/admission/reviews";
import type { ActionResult } from "./org";
import { done, reviewerGate } from "./admission/gate";
import { answersSchema, assignmentRefSchema, respondSchema, reviewSchema } from "./admission/schemas";

/*
 * Applicant and reviewer actions for applications (docs/ADMISSION.md).
 * Applicants act from their ticket page: the ticket token is the bearer, as
 * for cancelling a ticket, and each token is rate limited. The ticket page is
 * rendered per request, so the client refreshes it after each answer. Reviewers act on
 * their own assignments only (REVIEW_APPLICATIONS or owner/admin, behind
 * staff MFA).
 */

export async function respondToApplicationOffer(input: unknown): Promise<ActionResult<{ status: string; paying: boolean }>> {
  const parsed = respondSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  if (await isActionRateLimited("rsvp", parsed.data.token)) return { ok: false, error: "Too many attempts. Try again shortly." };
  const result = await respondAsApplicant(parsed.data.token, parsed.data.response);
  if (!result.ok) return result;
  return { ok: true, data: { status: result.status, paying: result.paying } };
}

export async function saveApplicationAnswers(input: unknown): Promise<ActionResult> {
  const parsed = answersSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  if (await isActionRateLimited("rsvp", parsed.data.token)) return { ok: false, error: "Too many attempts. Try again shortly." };
  const result = await editApplicationAnswers(parsed.data.token, parsed.data.answers);
  if (!result.ok) return result;
  return { ok: true };
}

export async function loadApplicationReview(input: unknown): Promise<ActionResult<ReviewItem>> {
  const gate = await reviewerGate(assignmentRefSchema, input);
  if (!gate.ok) return gate;
  const item = await loadReviewItem(gate.ctx, gate.data.assignmentId);
  return item ? { ok: true, data: item } : { ok: false, error: "This review isn't assigned to you." };
}

export async function submitApplicationReview(input: unknown): Promise<ActionResult> {
  const gate = await reviewerGate(reviewSchema, input);
  return gate.ok ? done(gate.ctx, await submitReview(gate.ctx, gate.data.assignmentId, { scores: gate.data.scores, notes: gate.data.notes })) : gate;
}

export async function recuseFromApplication(input: unknown): Promise<ActionResult<{ replacedBy: boolean }>> {
  const gate = await reviewerGate(assignmentRefSchema, input);
  return gate.ok ? done(gate.ctx, await recuse(gate.ctx, gate.data.assignmentId)) : gate;
}
