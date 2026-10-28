import "server-only";

/**
 * Organiser round management (docs/HACKATHON.md "Rounds"): create, configure,
 * delete and reorder rounds, set a round's panel, and open or close a round.
 * Owners and admins only (the callers resolve `JudgingOrganiserContext`);
 * everything runs under the organiser Event lock and is audited.
 */

import { EventPermission, JudgingRoundEntrySource, JudgingRoundStatus, Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import { isOrgAdmin } from "@/lib/permissions";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { JUDGING_ROUNDS_LIMIT, judgingRoundOrderSchema, judgingRoundPanelSchema, judgingRoundSchema } from "@/lib/validators/judgingRounds";
import { CHANGED, fail, invalid, isId, type JudgingEvent, type JudgingResult, ok, okEmpty, sameIdSet, withOrganiserLock } from "../shared";
import { type JudgingRoundScope, resolveJudgingRound } from "./scope";
import { ensureJudgingRound, syncCurrentRound } from "./sync";
import { changeRoundStatus } from "./status";

export const ROUND_NOT_FOUND = "Judging round not found.";

async function audit(tx: Prisma.TransactionClient, ctx: JudgingOrganiserContext, action: string, metadata: Record<string, string | number | boolean | null>) {
  await recordAuditEvent({ client: tx, action, actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId, metadata });
}

/** Run with the organiser Event lock and one of this event's rounds (refused for any other id). */
async function withRound<T>(
  ctx: JudgingOrganiserContext,
  roundId: unknown,
  run: (tx: Prisma.TransactionClient, event: JudgingEvent, round: JudgingRoundScope & { id: string }) => Promise<JudgingResult<T>>,
): Promise<JudgingResult<T>> {
  if (!isId(roundId)) return fail(ROUND_NOT_FOUND);
  return withOrganiserLock(ctx, async (tx, event) => {
    const round = await resolveJudgingRound(tx, event, roundId);
    if (!round?.id) return fail(ROUND_NOT_FOUND);
    return run(tx, event, { ...round, id: round.id });
  });
}

/**
 * Add a round after the last one (the event's first round, "Main", is
 * created first when it has none). A later round usually judges the
 * finalists advanced from the round before it (ADVANCED); the first round
 * always takes every submitted project.
 */
export async function createJudgingRound(ctx: JudgingOrganiserContext, input: unknown): Promise<JudgingResult<{ id: string }>> {
  const parsed = judgingRoundSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return withOrganiserLock(ctx, async (tx, event) => {
    if (!event.submissionsEnabled) return fail("Turn on submissions first.");
    if (event.resultsPublishedAt) return fail("Unpublish the results before adding a round.");
    await ensureJudgingRound(tx, event);
    const existing = await tx.judgingRound.aggregate({ where: { eventId: event.id }, _count: { _all: true }, _max: { position: true } });
    if (existing._count._all >= JUDGING_ROUNDS_LIMIT) return fail(`An event can have up to ${JUDGING_ROUNDS_LIMIT} judging rounds.`);
    const position = (existing._max.position ?? 0) + 1;
    const created = await tx.judgingRound.create({ data: { eventId: event.id, position, ...parsed.data }, select: { id: true } });
    await audit(tx, ctx, "JUDGING_ROUND_CREATED", { round: position, entrySource: parsed.data.entrySource });
    return ok({ id: created.id });
  });
}

/**
 * Change a round's settings. Its name, planned times and visibility can
 * change at any time (as the event-level settings could), its target and
 * score method until it is finalised; fresh eyes and which projects it judges
 * only while it is a DRAFT (the latter without finalists), and the first
 * round always takes every submitted project.
 */
export async function updateJudgingRound(ctx: JudgingOrganiserContext, roundId: unknown, input: unknown): Promise<JudgingResult> {
  const parsed = judgingRoundSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return withRound(ctx, roundId, async (tx, event, round) => {
    const data = parsed.data;
    if (data.entrySource !== round.entrySource) {
      if (round.position === 1) return fail("The first round always judges every submitted project.", { entrySource: ["The first round always judges every submitted project."] });
      if (round.status !== JudgingRoundStatus.DRAFT) return fail("Which projects a round judges is fixed once it opens.");
      if ((await tx.judgingRoundEntry.count({ where: { roundId: round.id } })) > 0) return fail("Remove this round's finalists before changing which projects it judges.");
    }
    // Fresh eyes decides who may see and review, so it is fixed once judging in the round starts.
    if (data.freshEyes !== round.freshEyes && round.status !== JudgingRoundStatus.DRAFT) return fail("Fresh eyes is fixed once the round opens.", { freshEyes: ["Fresh eyes is fixed once the round opens."] });
    // A finalised round's ranking is final: its target and score method stay as they were.
    if (round.finalizedAt && (data.scoreNormalization !== round.scoreNormalization || data.reviewsPerProject !== round.reviewsPerProject)) {
      return fail("This round is finalised, so its target and score method can't change. Undo finalising first.");
    }
    await tx.judgingRound.update({ where: { id: round.id }, data });
    await syncCurrentRound(tx, event.id);
    await audit(tx, ctx, "JUDGING_ROUND_UPDATED", { round: round.position, entrySource: data.entrySource, judgesSeeAll: data.judgesSeeAll, scoreNormalization: data.scoreNormalization });
    return okEmpty();
  });
}

/** Delete a DRAFT round other than the first; the rounds after it move up. Its rubric, panel and finalists go with it. */
export async function deleteJudgingRound(ctx: JudgingOrganiserContext, roundId: unknown): Promise<JudgingResult> {
  return withRound(ctx, roundId, async (tx, event, round) => {
    if (round.position === 1) return fail("The first round can't be deleted.");
    if (round.status !== JudgingRoundStatus.DRAFT) return fail("Only a round that hasn't opened can be deleted.");
    if (round.finalistsPublishedAt) return fail("Unpublish this round's finalists before deleting it.");
    if (await tx.reimbursementPolicy.count({ where: { judgingRoundId: round.id } })) return fail("A reimbursement policy is for this round. Delete that policy first (Finance tab).");
    await tx.judgingRound.delete({ where: { id: round.id } });
    const later = await tx.judgingRound.findMany({ where: { eventId: event.id, position: { gt: round.position } }, orderBy: { position: "asc" }, select: { id: true, position: true } });
    for (const row of later) await tx.judgingRound.update({ where: { id: row.id }, data: { position: row.position - 1 } });
    await syncCurrentRound(tx, event.id);
    await audit(tx, ctx, "JUDGING_ROUND_DELETED", { round: round.position });
    return okEmpty();
  });
}

/**
 * Apply a full new order. Rounds that have opened, or already hold
 * finalists, keep their place; the first round must take every submitted
 * project.
 */
export async function reorderJudgingRounds(ctx: JudgingOrganiserContext, ids: unknown): Promise<JudgingResult> {
  const parsed = judgingRoundOrderSchema.safeParse(ids);
  if (!parsed.success) return fail("Invalid order.");
  return withOrganiserLock(ctx, async (tx, event) => {
    const rounds = await tx.judgingRound.findMany({ where: { eventId: event.id }, select: { id: true, position: true, status: true, entrySource: true, _count: { select: { entries: true } } } });
    if (!sameIdSet(rounds.map((row) => row.id), parsed.data)) return fail(CHANGED);
    const byId = new Map(rounds.map((row) => [row.id, row]));
    for (const [index, id] of parsed.data.entries()) {
      const row = byId.get(id)!;
      const fixed = row.status !== JudgingRoundStatus.DRAFT || row._count.entries > 0;
      if (fixed && row.position !== index + 1) return fail("Rounds that have opened or hold finalists keep their place.");
    }
    if (byId.get(parsed.data[0]!)!.entrySource !== JudgingRoundEntrySource.ALL_SUBMITTED) return fail("The first round must judge every submitted project.");
    // Two passes keep (eventId, position) unique throughout.
    for (const row of rounds) await tx.judgingRound.update({ where: { id: row.id }, data: { position: row.position + 1000 } });
    for (const [index, id] of parsed.data.entries()) await tx.judgingRound.update({ where: { id }, data: { position: index + 1 } });
    await syncCurrentRound(tx, event.id);
    await audit(tx, ctx, "JUDGING_ROUNDS_REORDERED", { rounds: parsed.data.length });
    return okEmpty();
  });
}

/**
 * Set a round's own panel (an empty list removes it: everyone who can judge
 * the event judges the round). Each member must hold a JUDGE grant on the
 * event or be an organisation owner or admin. Not once the round is closed.
 */
export async function setJudgingRoundPanel(ctx: JudgingOrganiserContext, roundId: unknown, userIds: unknown): Promise<JudgingResult<{ panel: number }>> {
  const parsed = judgingRoundPanelSchema.safeParse(userIds);
  if (!parsed.success) return fail("Invalid judges.");
  return withRound(ctx, roundId, async (tx, event, round) => {
    if (round.status === JudgingRoundStatus.CLOSED) return fail("This round is closed, so its panel can't change.");
    const [admins, grants] = await Promise.all([
      tx.membership.findMany({ where: { organisationId: event.organisationId, userId: { in: parsed.data } }, select: { userId: true, role: true } }),
      tx.eventCollaborator.findMany({ where: { eventId: event.id, userId: { in: parsed.data }, permissions: { has: EventPermission.JUDGE } }, select: { userId: true } }),
    ]);
    const eligible = new Set([...admins.filter((row) => isOrgAdmin(row.role)).map((row) => row.userId), ...grants.flatMap((row) => (row.userId ? [row.userId] : []))]);
    if (parsed.data.some((id) => !eligible.has(id))) return fail("Some of the people you picked can no longer judge this event. Refresh and try again.");
    await tx.judgingRoundJudge.deleteMany({ where: { roundId: round.id } });
    if (parsed.data.length) await tx.judgingRoundJudge.createMany({ data: parsed.data.map((userId) => ({ roundId: round.id, userId })) });
    await audit(tx, ctx, "JUDGING_ROUND_PANEL_UPDATED", { round: round.position, judges: parsed.data.length });
    return ok({ panel: parsed.data.length });
  });
}

/** Open, close, or reset one round (the rules are in `changeRoundStatus`). */
export async function setJudgingRoundStatus(ctx: JudgingOrganiserContext, roundId: unknown, status: unknown): Promise<JudgingResult> {
  if (status !== JudgingRoundStatus.DRAFT && status !== JudgingRoundStatus.OPEN && status !== JudgingRoundStatus.CLOSED) return fail("Invalid judging status.");
  return withRound(ctx, roundId, (tx, event, round) => changeRoundStatus(tx, ctx, event, round, status));
}
