import "server-only";

/*
 * Mentoring rounds (stages) for team check-in visits, never judging
 * (round_management.py, round_workflow.transition). DRAFT -> LIVE ->
 * CLOSED, or SKIPPED; at most one LIVE round per event (partial unique
 * index); the form, triggers, overrides and fresh-eyes rule change only in
 * DRAFT. Each round may have its own organiser-chosen mentor pool.
 */

import { EventPermission, MentoringRoundStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/audit";
import { ROUND_LABEL_MAX_LENGTH, ROUNDS_MAX } from "@/lib/mentorDesk/rules";
import { roundFormSchema, validateTriggerRules } from "@/lib/mentorDesk/roundForm";
import { deskEvent, type DeskOrganiserContext } from "./access";
import { localToDate } from "./configuration";
import { COPY, checkVersion, type DeskResult, fail, inTransaction, lockEvent, refuse } from "./shared";

const saveSchema = z.object({
  roundId: z.string().min(1).max(128).optional(),
  expectedVersion: z.number().int().min(0),
  label: z.string().trim().min(1).max(ROUND_LABEL_MAX_LENGTH),
  opensAt: z.string().max(20),
  closesAt: z.string().max(20),
  formSchema: z.unknown(),
  helpTriggerRules: z.unknown().optional(),
  allowFreshEyesOverride: z.boolean().default(false),
  allowConflictOverride: z.boolean().default(false),
  freshEyesAcrossStages: z.boolean().default(false),
}).strict();

/** Creates or edits a DRAFT round; its window must lie inside the event. */
export async function saveMentoringRound(ctx: DeskOrganiserContext, input: unknown): Promise<DeskResult<{ id: string }>> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  const form = roundFormSchema.safeParse(parsed.data.formSchema ?? []);
  if (!form.success) return fail("Check the round form questions.");
  const { roundId, expectedVersion, ...data } = parsed.data;
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, ctx);
    await lockEvent(tx, event.id);
    const opensAt = localToDate(data.opensAt, event.timezone);
    const closesAt = localToDate(data.closesAt, event.timezone);
    if (!opensAt || !closesAt || !(event.startDateTime <= opensAt && opensAt < closesAt && closesAt <= event.endDateTime)) refuse(COPY.roundWindow);
    const categories = await tx.helpCategory.findMany({ where: { eventId: event.id, active: true }, select: { key: true } });
    const rules = validateTriggerRules(data.helpTriggerRules ?? [], form.data, new Set(categories.map((c) => c.key)));
    if (!rules) refuse("Use distinct rules over existing questions and help categories.");
    const values = {
      label: data.label, opensAt, closesAt, formSchema: form.data as Prisma.InputJsonValue, helpTriggerRules: rules as Prisma.InputJsonValue,
      allowFreshEyesOverride: data.allowFreshEyesOverride, allowConflictOverride: data.allowConflictOverride, freshEyesAcrossStages: data.freshEyesAcrossStages,
    };
    if (!roundId) {
      if (expectedVersion !== 0) refuse(COPY.stale);
      const count = await tx.mentoringRound.count({ where: { eventId: event.id } });
      if (count >= ROUNDS_MAX) refuse(`Use at most ${ROUNDS_MAX} rounds.`);
      const last = await tx.mentoringRound.aggregate({ where: { eventId: event.id }, _max: { position: true } });
      return tx.mentoringRound.create({ data: { ...values, eventId: event.id, position: (last._max.position ?? 0) + 1 }, select: { id: true } });
    }
    const row = await tx.mentoringRound.findFirst({ where: { id: roundId, eventId: event.id } });
    if (!row) refuse(COPY.notFound);
    checkVersion(row, expectedVersion);
    if (row.status !== MentoringRoundStatus.DRAFT) refuse(COPY.roundLocked);
    return tx.mentoringRound.update({ where: { id: row.id }, data: { ...values, formVersion: { increment: 1 }, version: { increment: 1 } }, select: { id: true } });
  });
}

const poolSchema = z.object({ roundId: z.string().min(1).max(128), mentorUserIds: z.array(z.string().min(1).max(128)).max(200) }).strict();

/** The round's mentor pool; an empty list means every eligible MENTOR grantee. */
export async function setRoundMentorPool(ctx: DeskOrganiserContext, input: unknown): Promise<DeskResult> {
  const parsed = poolSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  const ids = [...new Set(parsed.data.mentorUserIds)];
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, ctx);
    await lockEvent(tx, event.id);
    const round = await tx.mentoringRound.findFirst({ where: { id: parsed.data.roundId, eventId: event.id }, select: { id: true, status: true } });
    if (!round) refuse(COPY.notFound);
    if (round.status === MentoringRoundStatus.CLOSED || round.status === MentoringRoundStatus.SKIPPED) refuse(COPY.roundClosed);
    const grants = await tx.eventCollaborator.count({ where: { eventId: event.id, userId: { in: ids }, permissions: { has: EventPermission.MENTOR } } });
    if (grants !== ids.length) refuse("Choose mentors of this event.");
    await tx.mentoringRoundMentor.deleteMany({ where: { roundId: round.id, mentorUserId: { notIn: ids } } });
    await tx.mentoringRoundMentor.createMany({ data: ids.map((mentorUserId) => ({ roundId: round.id, mentorUserId })), skipDuplicates: true });
    await tx.mentoringRound.update({ where: { id: round.id }, data: { version: { increment: 1 } } });
    await recordAuditEvent({ client: tx, action: "MENTOR_ROUND_POOL_UPDATED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "MentoringRound", targetId: round.id, metadata: { mentors: ids.length } });
    return undefined;
  });
}

const transitionSchema = z.object({ roundId: z.string().min(1).max(128), action: z.enum(["open", "close", "skip"]), expectedVersion: z.number().int().min(1) }).strict();

/** Opens a round inside its window (one LIVE at a time), or closes/skips it, ending any visit leases. */
export async function transitionMentoringRound(ctx: DeskOrganiserContext, input: unknown): Promise<DeskResult> {
  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, ctx, { allowDisabled: parsed.data.action !== "open" });
    await lockEvent(tx, event.id);
    const row = await tx.mentoringRound.findFirst({ where: { id: parsed.data.roundId, eventId: event.id } });
    if (!row) refuse(COPY.notFound);
    checkVersion(row, parsed.data.expectedVersion);
    const now = new Date();
    if (parsed.data.action === "open") {
      if (row.status !== MentoringRoundStatus.DRAFT) refuse(COPY.stale);
      if (!(row.opensAt <= now && now < row.closesAt)) refuse(COPY.roundOutside);
      if (await tx.mentoringRound.findFirst({ where: { eventId: event.id, status: MentoringRoundStatus.LIVE }, select: { id: true } })) refuse(COPY.roundLive);
      await tx.mentoringRound.update({ where: { id: row.id }, data: { status: MentoringRoundStatus.LIVE, version: { increment: 1 } } });
    } else {
      if (row.status !== MentoringRoundStatus.DRAFT && row.status !== MentoringRoundStatus.LIVE) refuse(COPY.stale);
      await tx.mentoringVisit.updateMany({ where: { roundId: row.id, expiresAt: { gt: now } }, data: { expiresAt: now, version: { increment: 1 } } });
      await tx.mentoringRound.update({ where: { id: row.id }, data: { status: parsed.data.action === "close" ? MentoringRoundStatus.CLOSED : MentoringRoundStatus.SKIPPED, version: { increment: 1 } } });
    }
    await recordAuditEvent({ client: tx, action: `MENTOR_ROUND_${parsed.data.action.toUpperCase()}`, actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "MentoringRound", targetId: row.id });
    return undefined;
  }, COPY.roundLive);
}

/**
 * Who took part in a round: teams with a submitted, non-away check-in. For
 * other features' eligibility rules (e.g. per-stage reimbursements): a
 * registration took part when its team did.
 */
export async function teamsThatTookPartInRound(client: Prisma.TransactionClient, eventId: string, roundId: string): Promise<Set<string>> {
  const rows = await client.mentoringCheckIn.findMany({ where: { eventId, roundId, away: false }, select: { teamId: true } });
  return new Set(rows.map((row) => row.teamId));
}

export async function tookPartInRound(client: Prisma.TransactionClient, params: { eventId: string; roundId: string; teamId?: string | null; rsvpId?: string | null }): Promise<boolean> {
  let teamId = params.teamId ?? null;
  if (!teamId && params.rsvpId) teamId = (await client.rSVP.findFirst({ where: { id: params.rsvpId, eventId: params.eventId }, select: { teamId: true } }))?.teamId ?? null;
  if (!teamId) return false;
  return Boolean(await client.mentoringCheckIn.findFirst({ where: { eventId: params.eventId, roundId: params.roundId, teamId, away: false }, select: { id: true } }));
}
