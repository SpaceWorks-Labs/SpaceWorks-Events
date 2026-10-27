import "server-only";

/**
 * Assignment runs (docs/HACKATHON.md "Rounds"): the seed of a RANDOM run, the
 * fingerprint of a run's inputs, and the stored record of an applied run, so
 * an assignment can be explained and reproduced. Manual changes made after a
 * run are audited against it (`recordManualAssignment`).
 */

import { createHash, randomBytes } from "node:crypto";
import { JudgeAssignmentStrategy, Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import type { AssignmentPair, AutoAssignMode } from "@/lib/judgingAssignment";
import type { AutoAssignStrategy } from "@/lib/judgingProgress";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";

/** A fresh seed for a RANDOM run: 128 bits from the platform CSPRNG, as 32 hex characters. */
export function newAssignmentSeed(): string {
  return randomBytes(16).toString("hex");
}

/** What a run's plan was built from, as a short digest: projects, pool, existing assignments, blocked pairs, target, mode, strategy and seed. */
export function assignmentInputFingerprint(input: {
  projectIds: readonly string[];
  poolJudgeIds: readonly string[];
  existing: readonly AssignmentPair[];
  blocked: ReadonlySet<string>;
  perProject: number;
  mode: AutoAssignMode;
  strategy: AutoAssignStrategy;
  seed: string | null;
}): string {
  const hash = createHash("sha256");
  hash.update(`${input.strategy}:${input.mode}:${input.perProject}:${input.seed ?? "-"}\n`);
  for (const id of [...input.projectIds].sort()) hash.update(`p:${id}\n`);
  for (const id of [...new Set(input.poolJudgeIds)].sort()) hash.update(`j:${id}\n`);
  for (const key of input.existing.map((pair) => `${pair.judgeUserId}:${pair.submissionId}`).sort()) hash.update(`a:${key}\n`);
  for (const key of [...input.blocked].sort()) hash.update(`b:${key.replace("\u0000", ":")}\n`);
  return hash.digest("base64url").slice(0, 22);
}

export function strategyFor(strategy: AutoAssignStrategy): JudgeAssignmentStrategy {
  return strategy === "random" ? JudgeAssignmentStrategy.RANDOM : JudgeAssignmentStrategy.BALANCED;
}

/** Store an applied run; returns its id (audited by the caller with the same counts). */
export async function recordAssignmentRun(
  tx: Prisma.TransactionClient,
  run: { roundId: string; strategy: AutoAssignStrategy; mode: AutoAssignMode; seed: string | null; perProject: number; judges: number; added: number; removed: number; adopted: number; inputFingerprint: string; planFingerprint: string; createdByUserId: string },
): Promise<string> {
  const created = await tx.judgingAssignmentRun.create({
    data: { ...run, strategy: strategyFor(run.strategy), seed: run.strategy === "random" ? run.seed : null },
    select: { id: true },
  });
  return created.id;
}

/**
 * Audit a manual assignment change (Submissions → assign or unassign a
 * judge), naming the round and the latest automatic run it changes, if any.
 */
export async function recordManualAssignment(
  tx: Prisma.TransactionClient,
  ctx: JudgingOrganiserContext,
  change: { action: "JUDGE_ASSIGNED" | "JUDGE_UNASSIGNED"; roundId: string; roundPosition: number; judgeUserId: string; submissionId: string },
): Promise<void> {
  const latest = await tx.judgingAssignmentRun.findFirst({ where: { roundId: change.roundId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
  await recordAuditEvent({
    client: tx,
    action: change.action,
    actorUserId: ctx.userId,
    organisationId: ctx.organisationId,
    targetType: "Event",
    targetId: ctx.eventId,
    metadata: { round: change.roundPosition, judgeUserId: change.judgeUserId, submissionId: change.submissionId, afterRun: latest?.id ?? null },
  });
}
