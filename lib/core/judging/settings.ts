import "server-only";

/** Organiser settings, the rubric (frozen once judging starts), and the Judging tab's setup read model. */

import { JudgingRoundStatus, JudgingStatus, Prisma, SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { entrantDisplayName, type JudgingCriterionDto } from "@/lib/judgingDto";
import { JUDGING_CRITERIA_LIMIT, judgingCriterionSchema, judgingReorderSchema, judgingSettingsSchema } from "@/lib/validators";
import {
  CHANGED,
  criteriaFor,
  EVENT_NOT_FOUND,
  fail,
  invalid,
  isId,
  type JudgingEvent,
  judgingEventSelect,
  type JudgingResult,
  lockEventForOrganiser,
  nameSourceSelect,
  ok,
  okEmpty,
  RUBRIC_FROZEN,
  sameIdSet,
} from "./shared";
import { type JudgingRoundScope, resolveJudgingRound } from "./rounds/scope";
import { ensureJudgingRound } from "./rounds/sync";

/** Which round's rubric an edit is about: `roundId`, else the current round. */
export type RubricRoundOption = { roundId?: string | null };
const ROUND_NOT_FOUND = "Judging round not found.";

// ---------------------------------------------------------------------------
// Organiser: settings, rubric, awards, moderation
// ---------------------------------------------------------------------------

export type JudgingSettingsDto = {
  submissionsEnabled: boolean;
  submissionsOpenAt: Date | null;
  submissionsCloseAt: Date | null;
  judgingStatus: JudgingStatus;
  judgesSeeAll: boolean;
  projectGalleryPublic: boolean;
  resultsPublishedAt: Date | null;
  resultsAnnouncedAt: Date | null;
  emailEntrantsOnResults: boolean;
  emailSubmissionReceipts: boolean;
  timezone: string;
};

function settingsDto(event: JudgingEvent): JudgingSettingsDto {
  return {
    submissionsEnabled: event.submissionsEnabled,
    submissionsOpenAt: event.submissionsOpenAt,
    submissionsCloseAt: event.submissionsCloseAt,
    judgingStatus: event.judgingStatus,
    judgesSeeAll: event.judgesSeeAll,
    projectGalleryPublic: event.projectGalleryPublic,
    resultsPublishedAt: event.resultsPublishedAt,
    resultsAnnouncedAt: event.resultsAnnouncedAt,
    emailEntrantsOnResults: event.emailEntrantsOnResults,
    emailSubmissionReceipts: event.emailSubmissionReceipts,
    timezone: event.timezone,
  };
}

/** Why submissions can't be turned off right now, or null when they can. */
export function submissionsLockedOnReason(event: { submissionsEnabled: boolean; judgingStatus: JudgingStatus; resultsPublishedAt: Date | null }): string | null {
  if (!event.submissionsEnabled) return null;
  if (event.resultsPublishedAt) return "Results are published, so submissions stay on. Unpublish the results first.";
  if (event.judgingStatus !== JudgingStatus.NOT_STARTED) return "Judging has started, so submissions stay on. To stop taking projects, change the closing time.";
  return null;
}

/**
 * Save submission and judging settings, including the hackathon email
 * switches (left out, they keep their saved value). Audited
 * (JUDGING_SETTINGS_UPDATED, with both email switches and which changed).
 * `submissionsEnabled` switches the whole feature (judge workspace, results,
 * gallery), so it can't be turned off once judging has started or results are
 * published; closing the window is how an organiser stops new projects.
 */
export async function updateJudgingSettings(ctx: JudgingOrganiserContext, input: unknown): Promise<JudgingResult<JudgingSettingsDto>> {
  const parsed = judgingSettingsSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return prisma.$transaction(async (tx): Promise<JudgingResult<JudgingSettingsDto>> => {
    const event = await lockEventForOrganiser(tx, ctx);
    if (!event) return fail(EVENT_NOT_FOUND);
    const locked = parsed.data.submissionsEnabled ? null : submissionsLockedOnReason(event);
    if (locked) return fail(locked, { submissionsEnabled: [locked] });
    const updated = await tx.event.update({
      where: { id: event.id },
      data: {
        submissionsEnabled: parsed.data.submissionsEnabled,
        submissionsOpenAt: parsed.data.submissionsOpenAt,
        submissionsCloseAt: parsed.data.submissionsCloseAt,
        judgesSeeAll: parsed.data.judgesSeeAll,
        projectGalleryPublic: parsed.data.projectGalleryPublic,
        ...(parsed.data.emailEntrantsOnResults === undefined ? {} : { emailEntrantsOnResults: parsed.data.emailEntrantsOnResults }),
        ...(parsed.data.emailSubmissionReceipts === undefined ? {} : { emailSubmissionReceipts: parsed.data.emailSubmissionReceipts }),
      },
      select: judgingEventSelect,
    });
    // An event taking projects always has its first round (the visibility setting above mirrors onto the current round).
    if (updated.submissionsEnabled) await ensureJudgingRound(tx, updated);
    const emailTogglesChanged = (["emailEntrantsOnResults", "emailSubmissionReceipts"] as const).filter((name) => event[name] !== updated[name]);
    await recordAuditEvent({
      client: tx,
      action: "JUDGING_SETTINGS_UPDATED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: event.id,
      metadata: {
        submissionsEnabled: updated.submissionsEnabled,
        judgesSeeAll: updated.judgesSeeAll,
        projectGalleryPublic: updated.projectGalleryPublic,
        emailEntrantsOnResults: updated.emailEntrantsOnResults,
        emailSubmissionReceipts: updated.emailSubmissionReceipts,
        emailTogglesChanged: emailTogglesChanged.join(",") || null,
      },
    });
    return ok(settingsDto(updated));
  });
}

/** Lock the event and resolve the round whose rubric changes; refused once that round has left DRAFT. */
async function withRubricLock<T>(
  ctx: JudgingOrganiserContext,
  options: RubricRoundOption,
  run: (tx: Prisma.TransactionClient, event: JudgingEvent, round: JudgingRoundScope & { id: string }) => Promise<JudgingResult<T>>,
): Promise<JudgingResult<T>> {
  return prisma.$transaction(async (tx): Promise<JudgingResult<T>> => {
    const event = await lockEventForOrganiser(tx, ctx);
    if (!event) return fail(EVENT_NOT_FOUND);
    const round = options.roundId ? await resolveJudgingRound(tx, event, options.roundId) : await ensureJudgingRound(tx, event);
    if (!round?.id) return fail(ROUND_NOT_FOUND);
    if (round.status !== JudgingRoundStatus.DRAFT) return fail(RUBRIC_FROZEN);
    return run(tx, event, { ...round, id: round.id });
  });
}

export async function createJudgingCriterion(ctx: JudgingOrganiserContext, input: unknown, options: RubricRoundOption = {}): Promise<JudgingResult<{ id: string }>> {
  const parsed = judgingCriterionSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return withRubricLock(ctx, options, async (tx, event, round) => {
    const existing = await tx.judgingCriterion.aggregate({ where: { eventId: event.id, roundId: round.id }, _count: { _all: true }, _max: { position: true } });
    if (existing._count._all >= JUDGING_CRITERIA_LIMIT) return fail(`A rubric can have up to ${JUDGING_CRITERIA_LIMIT} criteria.`);
    const created = await tx.judgingCriterion.create({
      data: { eventId: event.id, roundId: round.id, ...parsed.data, position: (existing._max.position ?? -1) + 1 },
      select: { id: true },
    });
    return ok({ id: created.id });
  });
}

export async function updateJudgingCriterion(ctx: JudgingOrganiserContext, criterionId: string, input: unknown, options: RubricRoundOption = {}): Promise<JudgingResult> {
  if (!isId(criterionId)) return fail("Criterion not found.");
  const parsed = judgingCriterionSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return withRubricLock(ctx, options, async (tx, event, round) => {
    const updated = await tx.judgingCriterion.updateMany({ where: { id: criterionId, eventId: event.id, roundId: round.id }, data: parsed.data });
    return updated.count === 1 ? okEmpty() : fail("Criterion not found.");
  });
}

export async function deleteJudgingCriterion(ctx: JudgingOrganiserContext, criterionId: string, options: RubricRoundOption = {}): Promise<JudgingResult> {
  if (!isId(criterionId)) return fail("Criterion not found.");
  return withRubricLock(ctx, options, async (tx, event, round) => {
    const deleted = await tx.judgingCriterion.deleteMany({ where: { id: criterionId, eventId: event.id, roundId: round.id } });
    return deleted.count === 1 ? okEmpty() : fail("Criterion not found.");
  });
}

/** Apply a full new order; `ids` must be exactly the round's criteria. */
export async function reorderJudgingCriteria(ctx: JudgingOrganiserContext, ids: unknown, options: RubricRoundOption = {}): Promise<JudgingResult> {
  const parsed = judgingReorderSchema.safeParse(ids);
  if (!parsed.success) return fail("Invalid order.");
  return withRubricLock(ctx, options, async (tx, event, round) => {
    const current = await tx.judgingCriterion.findMany({ where: { eventId: event.id, roundId: round.id }, select: { id: true } });
    if (!sameIdSet(current.map((row) => row.id), parsed.data)) return fail(CHANGED);
    for (const [position, id] of parsed.data.entries()) {
      await tx.judgingCriterion.updateMany({ where: { id, eventId: event.id, roundId: round.id }, data: { position } });
    }
    return okEmpty();
  });
}

export type OrganiserAwardDto = {
  id: string;
  name: string;
  description: string;
  winners: Array<{ place: number; submissionId: string; title: string; entrantName: string }>;
};

export type JudgingSetupDto = {
  settings: JudgingSettingsDto;
  criteria: JudgingCriterionDto[];
  awards: OrganiserAwardDto[];
  counts: Record<SubmissionStatus, number>;
};

/** Everything the organiser Judging tab needs to render its settings, rubric, and awards. */
export async function loadJudgingSetup(ctx: JudgingOrganiserContext): Promise<JudgingSetupDto | null> {
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: judgingEventSelect });
  if (!event) return null;
  const round = await resolveJudgingRound(prisma, event);
  const [criteria, awards, grouped] = await Promise.all([
    round ? criteriaFor(prisma, round) : [],
    prisma.eventAward.findMany({
      where: { eventId: event.id },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        description: true,
        winners: { orderBy: { place: "asc" }, select: { place: true, submission: { select: { id: true, title: true, ...nameSourceSelect } } } },
      },
    }),
    prisma.submission.groupBy({ by: ["status"], where: { eventId: event.id }, _count: { _all: true } }),
  ]);
  const counts = { DRAFT: 0, SUBMITTED: 0, WITHDRAWN: 0, DISQUALIFIED: 0 } as Record<SubmissionStatus, number>;
  for (const row of grouped) counts[row.status] = row._count._all;
  return {
    settings: settingsDto(event),
    criteria,
    awards: awards.map((award) => ({
      id: award.id,
      name: award.name,
      description: award.description,
      winners: award.winners.map((winner) => ({
        place: winner.place,
        submissionId: winner.submission.id,
        title: winner.submission.title,
        entrantName: entrantDisplayName(winner.submission),
      })),
    })),
    counts,
  };
}
