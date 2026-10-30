import "server-only";

/*
 * Round visits (round_workflow.visit): a ten-minute heartbeat lease on a
 * team, generation-fenced. Fresh eyes: a mentor never revisits a team they
 * checked in before, and declared/affiliation conflicts are refused, unless
 * the round allows an override and the mentor gives a reason. Membership is
 * never overridable. One check-in per team and round, possibly "away";
 * nominations need a real (non-away) visit and are a private advisory signal.
 */

import { randomUUID } from "node:crypto";
import { HelpRequestOrigin, MentoringRoundStatus, Prisma, RsvpStatus } from "@prisma/client";
import { z } from "zod";
import { OVERRIDE_REASON_MAX_LENGTH, visitLeaseExpiry } from "@/lib/mentorDesk/rules";
import { firedTriggers, parseRoundForm, parseTriggerRules, validateRoundAnswers } from "@/lib/mentorDesk/roundForm";
import { deskEvent, liveMentor, teamMemberUserIds, type MentorContext } from "./access";
import { createHelpLocked } from "./help";
import { COPY, checkVersion, type DeskResult, fail, inTransaction, lockHelpEvent, refuse } from "./shared";

const schema = z.object({
  roundId: z.string().min(1).max(128),
  teamId: z.string().min(1).max(128),
  action: z.enum(["claim", "heartbeat", "release", "submit"]),
  expectedVersion: z.number().int().min(1),
  leaseId: z.string().max(64).optional(),
  generation: z.number().int().min(1).optional(),
  overrideReason: z.string().trim().max(OVERRIDE_REASON_MAX_LENGTH).optional().default(""),
  formVersion: z.number().int().min(1).optional(),
  answers: z.unknown().optional(),
  away: z.boolean().optional().default(false),
  nominate: z.boolean().optional().default(false),
});

async function lockRound(tx: Prisma.TransactionClient, eventId: string, roundId: string) {
  await tx.$queryRaw`SELECT "id" FROM "MentoringRound" WHERE "id" = ${roundId} AND "eventId" = ${eventId} FOR UPDATE`;
  const round = await tx.mentoringRound.findFirst({ where: { id: roundId, eventId }, include: { mentors: { select: { mentorUserId: true } } } });
  if (!round) refuse(COPY.notFound);
  return round;
}

/** Whether a mentor belongs to the round's pool (no pool rows: everyone). */
export function inRoundPool(round: { mentors: Array<{ mentorUserId: string }> }, userId: string) {
  return round.mentors.length === 0 || round.mentors.some((m) => m.mentorUserId === userId);
}

async function declaredConflict(tx: Prisma.TransactionClient, eventId: string, mentorUserId: string, teamId: string) {
  return Boolean(await tx.mentorConflict.findFirst({ where: { eventId, mentorUserId, teamId, active: true }, select: { id: true } }));
}

export async function visitCommand(m: MentorContext, input: unknown): Promise<DeskResult<{ leaseId?: string; generation?: number; checkInId?: string }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  const data = parsed.data;
  return inTransaction(async (tx) => {
    await lockHelpEvent(tx, m.eventId);
    const event = await deskEvent(tx, m);
    const now = new Date();
    await liveMentor(tx, event.id, m.userId, { at: now });
    const round = await lockRound(tx, event.id, data.roundId);
    if (round.status !== MentoringRoundStatus.LIVE) refuse(COPY.stale);
    if (now >= round.closesAt) refuse(COPY.roundClosed);
    if (!inRoundPool(round, m.userId)) refuse("You are not in this round's mentor pool.");
    const team = await tx.team.findFirst({ where: { id: data.teamId, eventId: event.id, status: RsvpStatus.CONFIRMED }, select: { id: true } });
    if (!team) refuse(COPY.notFound);
    if (await tx.mentoringCheckIn.findFirst({ where: { roundId: round.id, teamId: team.id }, select: { id: true } })) refuse(COPY.alreadySubmitted);
    await tx.$queryRaw`SELECT "id" FROM "MentoringVisit" WHERE "roundId" = ${round.id} AND "teamId" = ${team.id} FOR UPDATE`;
    const lease = await tx.mentoringVisit.findUnique({ where: { roundId_teamId: { roundId: round.id, teamId: team.id } } });
    const ownTeam = (await teamMemberUserIds(tx, team.id)).has(m.userId);

    if (data.action === "claim") {
      checkVersion(round, data.expectedVersion);
      if (lease && lease.expiresAt > now) refuse(COPY.teamBusy);
      if (ownTeam) refuse(COPY.ownTeam);
      const reason = data.overrideReason;
      if ((await declaredConflict(tx, event.id, m.userId, team.id)) && !(round.allowConflictOverride && reason)) refuse(COPY.conflictVisit);
      const seen = await tx.mentoringCheckIn.findFirst({ where: { eventId: event.id, teamId: team.id, mentorUserId: m.userId }, select: { id: true } });
      if (seen && !(round.allowFreshEyesOverride && reason)) refuse(COPY.freshEyes);
      const values = { mentorUserId: m.userId, leaseId: randomUUID(), generation: (lease?.generation ?? 0) + 1, expiresAt: visitLeaseExpiry(now, round.closesAt), heartbeatAt: now, startedAt: now, overrideReason: reason };
      const row = lease
        ? await tx.mentoringVisit.update({ where: { id: lease.id }, data: { ...values, version: { increment: 1 } } })
        : await tx.mentoringVisit.create({ data: { ...values, eventId: event.id, roundId: round.id, teamId: team.id } });
      return { leaseId: row.leaseId, generation: row.generation };
    }

    if (!lease) refuse(COPY.visitLease);
    if (ownTeam) refuse(COPY.ownTeam);
    if ((await declaredConflict(tx, event.id, m.userId, team.id)) && !(round.allowConflictOverride && lease.overrideReason.trim())) refuse(COPY.conflictVisit);
    if (lease.mentorUserId !== m.userId || lease.leaseId !== data.leaseId || lease.generation !== data.generation || lease.expiresAt <= now) refuse(COPY.visitLease);
    if (data.action === "heartbeat") {
      await tx.mentoringVisit.update({ where: { id: lease.id }, data: { expiresAt: visitLeaseExpiry(now, round.closesAt), heartbeatAt: now, version: { increment: 1 } } });
      return {};
    }
    if (data.action === "release") {
      await tx.mentoringVisit.update({ where: { id: lease.id }, data: { expiresAt: now, version: { increment: 1 } } });
      return {};
    }
    if (data.nominate && data.away) refuse(COPY.awayNomination);
    if (data.formVersion !== round.formVersion) refuse(COPY.formChanged);
    const questions = parseRoundForm(round.formSchema);
    const answers = data.away && (data.answers === undefined || data.answers === null) ? {} : validateRoundAnswers(data.away ? questions.map((q) => ({ ...q, required: false })) : questions, data.answers ?? {});
    if (!answers) refuse(COPY.answers);
    const checkIn = await tx.mentoringCheckIn.create({
      data: { eventId: event.id, roundId: round.id, teamId: team.id, mentorUserId: m.userId, formSnapshot: questions as Prisma.InputJsonValue, answers, overrideReason: lease.overrideReason, away: data.away, startedAt: lease.startedAt, submittedAt: now },
      select: { id: true },
    });
    if (data.nominate) await tx.mentorNomination.create({ data: { eventId: event.id, roundId: round.id, teamId: team.id, mentorUserId: m.userId } });
    // round_triggers.fire_locked: answers may raise follow-up help; a full category is skipped silently.
    for (const rule of firedTriggers(parseTriggerRules(round.helpTriggerRules), answers)) {
      const dedupKey = `${round.id}:${team.id}:${rule.key}`;
      if (await tx.helpRequest.findFirst({ where: { eventId: event.id, dedupKey }, select: { id: true } })) continue;
      const category = await tx.helpCategory.findFirst({ where: { eventId: event.id, key: rule.categoryKey, active: true }, select: { id: true } });
      if (!category) continue;
      await createHelpLocked(tx, { event, scope: { teamId: team.id, rsvpId: null }, categoryKey: rule.categoryKey, summary: "Follow-up requested during a mentoring round.", location: "", origin: HelpRequestOrigin.ROUND, raisedByUserId: m.userId, roundId: round.id, dedupKey, now });
    }
    await tx.mentoringVisit.update({ where: { id: lease.id }, data: { expiresAt: now, version: { increment: 1 } } });
    return { checkInId: checkIn.id };
  }, COPY.teamBusy);
}

/** configuration_workflow.nominate: after the mentor's own non-away check-in, once per round and team. */
export async function nominateTeam(m: MentorContext, input: unknown): Promise<DeskResult> {
  const parsed = z.object({ roundId: z.string().min(1).max(128), teamId: z.string().min(1).max(128) }).safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, m);
    await liveMentor(tx, event.id, m.userId, { onShift: false });
    const round = await lockRound(tx, event.id, parsed.data.roundId);
    const visited = await tx.mentoringCheckIn.findFirst({ where: { roundId: round.id, teamId: parsed.data.teamId, mentorUserId: m.userId, away: false }, select: { id: true } });
    if (!visited) refuse(COPY.visitRequired);
    await tx.mentorNomination.create({ data: { eventId: event.id, roundId: round.id, teamId: parsed.data.teamId, mentorUserId: m.userId } });
    return undefined;
  }, COPY.alreadyNominated);
}
