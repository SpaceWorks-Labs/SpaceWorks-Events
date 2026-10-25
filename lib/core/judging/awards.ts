import "server-only";

/** Organiser awards: create, edit, delete, reorder, and pick or remove winners. */

import { SubmissionStatus } from "@prisma/client";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { awardWinnerSchema, EVENT_AWARDS_LIMIT, eventAwardSchema, judgingReorderSchema, removeAwardWinnerSchema } from "@/lib/validators";
import { CHANGED, fail, invalid, isId, type JudgingResult, NOT_FOUND, ok, okEmpty, sameIdSet, withOrganiserLock } from "./shared";

export async function createEventAward(ctx: JudgingOrganiserContext, input: unknown): Promise<JudgingResult<{ id: string }>> {
  const parsed = eventAwardSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return withOrganiserLock(ctx, async (tx, event) => {
    const existing = await tx.eventAward.aggregate({ where: { eventId: event.id }, _count: { _all: true }, _max: { position: true } });
    if (existing._count._all >= EVENT_AWARDS_LIMIT) return fail(`An event can have up to ${EVENT_AWARDS_LIMIT} awards.`);
    const created = await tx.eventAward.create({
      data: { eventId: event.id, ...parsed.data, position: (existing._max.position ?? -1) + 1 },
      select: { id: true },
    });
    return ok({ id: created.id });
  });
}

export async function updateEventAward(ctx: JudgingOrganiserContext, awardId: string, input: unknown): Promise<JudgingResult> {
  if (!isId(awardId)) return fail("Award not found.");
  const parsed = eventAwardSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return withOrganiserLock(ctx, async (tx, event) => {
    const updated = await tx.eventAward.updateMany({ where: { id: awardId, eventId: event.id }, data: parsed.data });
    return updated.count === 1 ? okEmpty() : fail("Award not found.");
  });
}

export async function deleteEventAward(ctx: JudgingOrganiserContext, awardId: string): Promise<JudgingResult> {
  if (!isId(awardId)) return fail("Award not found.");
  return withOrganiserLock(ctx, async (tx, event) => {
    const deleted = await tx.eventAward.deleteMany({ where: { id: awardId, eventId: event.id } });
    return deleted.count === 1 ? okEmpty() : fail("Award not found.");
  });
}

export async function reorderEventAwards(ctx: JudgingOrganiserContext, ids: unknown): Promise<JudgingResult> {
  const parsed = judgingReorderSchema.safeParse(ids);
  if (!parsed.success) return fail("Invalid order.");
  return withOrganiserLock(ctx, async (tx, event) => {
    const current = await tx.eventAward.findMany({ where: { eventId: event.id }, select: { id: true } });
    if (!sameIdSet(current.map((row) => row.id), parsed.data)) return fail(CHANGED);
    for (const [position, id] of parsed.data.entries()) {
      await tx.eventAward.updateMany({ where: { id, eventId: event.id }, data: { position } });
    }
    return okEmpty();
  });
}

/**
 * Put a SUBMITTED project in a place of an award. Replaces whoever held that
 * place, and moves the project if it already held another place in this award.
 */
export async function setAwardWinner(ctx: JudgingOrganiserContext, input: unknown): Promise<JudgingResult> {
  const parsed = awardWinnerSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return withOrganiserLock(ctx, async (tx, event) => {
    const award = await tx.eventAward.findFirst({ where: { id: parsed.data.awardId, eventId: event.id }, select: { id: true } });
    if (!award) return fail("Award not found.");
    const submission = await tx.submission.findFirst({ where: { id: parsed.data.submissionId, eventId: event.id }, select: { id: true, status: true } });
    if (!submission) return fail(NOT_FOUND);
    if (submission.status !== SubmissionStatus.SUBMITTED) return fail("Only submitted projects can win an award.");
    await tx.eventAwardWinner.deleteMany({ where: { awardId: award.id, OR: [{ place: parsed.data.place }, { submissionId: submission.id }] } });
    await tx.eventAwardWinner.create({ data: { awardId: award.id, submissionId: submission.id, place: parsed.data.place } });
    return okEmpty();
  });
}

export async function removeAwardWinner(ctx: JudgingOrganiserContext, input: unknown): Promise<JudgingResult> {
  const parsed = removeAwardWinnerSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input.");
  return withOrganiserLock(ctx, async (tx, event) => {
    const deleted = await tx.eventAwardWinner.deleteMany({ where: { place: parsed.data.place, award: { id: parsed.data.awardId, eventId: event.id } } });
    return deleted.count === 1 ? okEmpty() : fail("Winner not found.");
  });
}
