import "server-only";

/*
 * Mentor-team assignment (assignment_workflow.py), per event or per round.
 * Preview writes nothing and shows the seed (RANDOM) and the inputs
 * fingerprint; apply re-reads the inputs under the event lock, refuses when
 * they changed since the preview, and records the run with every decision
 * and every uncovered team. PROPOSED -> ACTIVE -> ENDED commands recheck
 * eligibility, conflicts and capacity. Organisers can then hand-edit; those
 * mappings are marked manualOverride.
 */

import { randomBytes } from "node:crypto";
import { MentorAssignmentMode, MentorAssignmentStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/audit";
import { allocate } from "@/lib/mentorDesk/allocation";
import { MENTOR_ASSIGNED_KIND, enqueueMentorMessages } from "@/lib/outbox/mentor";
import { deskEvent, liveMentor, type DeskOrganiserContext } from "./access";
import { inputFingerprint, readAllocationInputs, type AssignmentScope } from "./assignmentInputs";
import { isBlockedForTeam } from "./eligibility";
import { COPY, checkVersion, type DeskResult, fail, inTransaction, lockEvent, refuse } from "./shared";

const runSchema = z.object({
  roundId: z.string().min(1).max(128).nullable().default(null),
  mode: z.nativeEnum(MentorAssignmentMode),
  seed: z.string().regex(/^[a-f0-9]{16,64}$/).optional(),
  manual: z.record(z.string().max(128), z.string().max(128)).optional(),
});

export type AssignmentPreview = {
  mode: MentorAssignmentMode;
  roundId: string | null;
  seed: string | null;
  fingerprint: string;
  assignments: Array<{ teamId: string; teamName: string; mentorUserId: string; mentorName: string }>;
  uncovered: Array<{ teamId: string; teamName: string }>;
};

async function plan(tx: Prisma.TransactionClient, eventId: string, data: z.infer<typeof runSchema>, seed: string | null): Promise<AssignmentPreview> {
  const scope: AssignmentScope = { eventId, roundId: data.roundId };
  const manual = data.mode === MentorAssignmentMode.MANUAL ? data.manual ?? {} : undefined;
  const inputs = await readAllocationInputs(tx, scope, manual ? Object.keys(manual) : undefined);
  const result = allocate({ teams: inputs.teams, candidates: inputs.candidates, mode: data.mode, manual, seed: seed ?? undefined });
  return {
    mode: data.mode,
    roundId: data.roundId,
    seed,
    fingerprint: inputFingerprint({ mode: data.mode, scope, inputs, manual }),
    assignments: result.assignments.map((a) => ({ ...a, teamName: inputs.teamNames.get(a.teamId) ?? "Team", mentorName: inputs.names.get(a.mentorUserId) ?? "Mentor" })),
    uncovered: result.uncoveredTeamIds.map((teamId) => ({ teamId, teamName: inputs.teamNames.get(teamId) ?? "Team" })),
  };
}

/** A fresh crypto-random seed for RANDOM ("re-roll" asks for another preview without one). */
export function newSeed() {
  return randomBytes(16).toString("hex");
}

/** Writes nothing. RANDOM without a seed gets a new one, shown so the result can be re-applied exactly. */
export async function previewAssignments(ctx: DeskOrganiserContext, input: unknown): Promise<DeskResult<AssignmentPreview>> {
  const parsed = runSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  const seed = parsed.data.mode === MentorAssignmentMode.RANDOM ? parsed.data.seed ?? newSeed() : null;
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, ctx);
    return plan(tx, event.id, parsed.data, seed);
  });
}

const applySchema = runSchema.extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), proposed: z.boolean().default(false) });

async function notifyMentors(tx: Prisma.TransactionClient, ids: string[]) {
  if (ids.length === 0) return;
  const rows = await tx.mentorTeamAssignment.findMany({ where: { id: { in: ids } }, select: { id: true, mentor: { select: { email: true } } } });
  for (const row of rows) if (row.mentor.email) await enqueueMentorMessages(tx, MENTOR_ASSIGNED_KIND, [{ to: row.mentor.email, id: row.id }]);
}

/** Applies a previewed run under the event lock; refused when anything it depended on changed. */
export async function applyAssignments(ctx: DeskOrganiserContext, input: unknown): Promise<DeskResult<{ runId: string; created: number; uncovered: number }>> {
  const parsed = applySchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  const data = parsed.data;
  if (data.mode === MentorAssignmentMode.RANDOM && !data.seed) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, ctx);
    await lockEvent(tx, event.id);
    const result = await plan(tx, event.id, data, data.seed ?? null);
    if (result.fingerprint !== data.fingerprint) refuse("The mentors or teams changed; refresh the preview.");
    const run = await tx.mentorAssignmentRun.create({
      data: {
        eventId: event.id, roundId: data.roundId, mode: data.mode, seed: result.seed, inputFingerprint: result.fingerprint, createdByUserId: ctx.userId,
        decisions: result.assignments.map((a) => ({ teamId: a.teamId, mentorUserId: a.mentorUserId })),
        uncoveredTeamIds: result.uncovered.map((u) => u.teamId),
      },
      select: { id: true },
    });
    const status = data.proposed ? MentorAssignmentStatus.PROPOSED : MentorAssignmentStatus.ACTIVE;
    const created: string[] = [];
    for (const a of result.assignments) {
      const row = await tx.mentorTeamAssignment.create({ data: { eventId: event.id, roundId: data.roundId, mentorUserId: a.mentorUserId, teamId: a.teamId, mode: data.mode, status, runId: run.id, createdByUserId: ctx.userId }, select: { id: true } });
      created.push(row.id);
    }
    if (status === MentorAssignmentStatus.ACTIVE) await notifyMentors(tx, created);
    await recordAuditEvent({ client: tx, action: "MENTOR_ASSIGNMENT_RUN_APPLIED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "MentorAssignmentRun", targetId: run.id, metadata: { mode: data.mode, assigned: created.length, uncovered: result.uncovered.length } });
    return { runId: run.id, created: created.length, uncovered: result.uncovered.length };
  });
}

/** Capacity, conflicts and hard fresh eyes for one mentor and team in a scope (activation and hand edits). */
async function requireAssignable(tx: Prisma.TransactionClient, scope: AssignmentScope, mentorUserId: string, teamId: string, exceptId?: string) {
  const mentor = await liveMentor(tx, scope.eventId, mentorUserId, { onShift: false });
  if (await isBlockedForTeam(tx, scope.eventId, mentorUserId, teamId)) refuse(COPY.conflict);
  const inputs = await readAllocationInputs(tx, scope, [teamId], exceptId);
  const candidate = inputs.candidates.find((c) => c.id === mentorUserId);
  if (!candidate || inputs.teams.length === 0 || candidate.excludedTeamIds.has(teamId)) refuse(COPY.conflict);
  if (candidate.load >= mentor.maxActiveTeams) refuse(COPY.full);
}

const transitionSchema = z.object({ assignmentId: z.string().min(1).max(128), action: z.enum(["activate", "end"]), expectedVersion: z.number().int().min(1) });

export async function transitionAssignment(ctx: DeskOrganiserContext, input: unknown): Promise<DeskResult> {
  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, ctx, { allowDisabled: parsed.data.action === "end" });
    await lockEvent(tx, event.id);
    const row = await tx.mentorTeamAssignment.findFirst({ where: { id: parsed.data.assignmentId, eventId: event.id } });
    if (!row) refuse(COPY.notFound);
    checkVersion(row, parsed.data.expectedVersion);
    const now = new Date();
    if (parsed.data.action === "activate") {
      if (row.status !== MentorAssignmentStatus.PROPOSED) refuse(COPY.stale);
      await requireAssignable(tx, { eventId: event.id, roundId: row.roundId }, row.mentorUserId, row.teamId, row.id);
      await tx.mentorTeamAssignment.update({ where: { id: row.id }, data: { status: MentorAssignmentStatus.ACTIVE, activeFrom: now, version: { increment: 1 } } });
      await notifyMentors(tx, [row.id]);
    } else {
      if (row.status === MentorAssignmentStatus.ENDED) refuse(COPY.stale);
      await tx.mentorTeamAssignment.update({ where: { id: row.id }, data: { status: MentorAssignmentStatus.ENDED, endedAt: now, version: { increment: 1 } } });
    }
    await recordAuditEvent({ client: tx, action: parsed.data.action === "activate" ? "MENTOR_ASSIGNMENT_ACTIVATED" : "MENTOR_ASSIGNMENT_ENDED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "MentorTeamAssignment", targetId: row.id });
    return undefined;
  });
}

const manualSchema = z.object({ roundId: z.string().min(1).max(128).nullable().default(null), mentorUserId: z.string().min(1).max(128), teamId: z.string().min(1).max(128) });

/** An organiser's hand edit after (or instead of) a run: one ACTIVE mapping, recorded as a manual override. */
export async function assignMentorManually(ctx: DeskOrganiserContext, input: unknown): Promise<DeskResult<{ id: string }>> {
  const parsed = manualSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, ctx);
    await lockEvent(tx, event.id);
    const scope = { eventId: event.id, roundId: parsed.data.roundId };
    await requireAssignable(tx, scope, parsed.data.mentorUserId, parsed.data.teamId);
    const row = await tx.mentorTeamAssignment.create({ data: { ...scope, mentorUserId: parsed.data.mentorUserId, teamId: parsed.data.teamId, mode: MentorAssignmentMode.MANUAL, manualOverride: true, createdByUserId: ctx.userId }, select: { id: true } });
    await notifyMentors(tx, [row.id]);
    await recordAuditEvent({ client: tx, action: "MENTOR_ASSIGNMENT_OVERRIDDEN", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "MentorTeamAssignment", targetId: row.id });
    return row;
  }, "This mentor already has this team.");
}
