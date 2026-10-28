import "server-only";

import { CrewKind, ExpenseCategory, JudgingRoundEntrySource, MentoringRoundStatus, ReimbursementEligibility, type Prisma } from "@prisma/client";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { parseMoneyToMinor } from "@/lib/payments/money";
import { safeTimeZone, zonedInputToIso } from "@/lib/timeZone";
import { fail, financeCurrency, ok, type ClaimResult } from "../shared";
import { stageColumn } from "./eligibility";

/**
 * Creating, editing, closing and deleting reimbursement policies
 * (docs/FINANCE.md "Reimbursement policies"): organisation owners and admins
 * only (the caller checks), under the event row lock, audited.
 */

export type PolicyAdminContext = { userId: string; organisationId: string; eventId: string };

export const MAX_POLICIES_PER_EVENT = 20;
const id = z.string().trim().min(1).max(128);
const optionalId = z.string().trim().max(128).default("");

const saveSchema = z.object({
  policyId: optionalId,
  name: z.string().trim().min(1, "Name the policy.").max(80),
  eligibility: z.nativeEnum(ReimbursementEligibility),
  judgingRoundId: optionalId,
  mentoringRoundId: optionalId,
  admissionStageId: optionalId,
  requireFinalistsPublished: z.boolean().default(false),
  crewKinds: z.array(z.nativeEnum(CrewKind)).max(4).default([]),
  cap: z.string().trim().min(1, "Enter the most each person gets back.").max(20),
  categories: z.array(z.nativeEnum(ExpenseCategory)).min(1, "Choose at least one category.").max(9),
  claimOpensAt: z.string().trim().max(20).default(""),
  claimClosesAt: z.string().trim().max(20).default(""),
  attendanceRequired: z.boolean().default(false),
  budget: z.string().trim().max(20).default(""),
  active: z.boolean().default(true),
  notifyWhenAvailable: z.boolean().default(false),
}).strict();

type SaveInput = z.infer<typeof saveSchema>;

async function lockedEvent(tx: Prisma.TransactionClient, ctx: PolicyAdminContext) {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${ctx.eventId} FOR UPDATE`;
  return tx.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: { id: true, currency: true, organisationId: true, timezone: true } });
}

type Stage = { judgingRoundId: string | null; mentoringRoundId: string | null; admissionStageId: string | null };

/** The stage the kind needs, checked against the event; an error sentence when it doesn't fit. */
async function stageFor(tx: Prisma.TransactionClient, eventId: string, data: SaveInput): Promise<Stage | string> {
  const column = stageColumn(data.eligibility);
  if (column === "judgingRoundId") {
    const round = data.judgingRoundId ? await tx.judgingRound.findFirst({ where: { id: data.judgingRoundId, eventId }, select: { id: true, entrySource: true } }) : null;
    if (!round) return "Choose the judging round.";
    if (round.entrySource !== JudgingRoundEntrySource.ADVANCED) return "Choose a round that takes advanced projects (finalists).";
    return { judgingRoundId: round.id, mentoringRoundId: null, admissionStageId: null };
  }
  if (column === "mentoringRoundId") {
    const round = data.mentoringRoundId ? await tx.mentoringRound.findFirst({ where: { id: data.mentoringRoundId, eventId }, select: { id: true, status: true } }) : null;
    if (!round) return "Choose the mentoring round.";
    if (round.status === MentoringRoundStatus.SKIPPED) return "That mentoring round was skipped.";
    return { judgingRoundId: null, mentoringRoundId: round.id, admissionStageId: null };
  }
  if (column === "admissionStageId") {
    const stage = data.admissionStageId ? await tx.admissionStage.findFirst({ where: { id: data.admissionStageId, eventId, event: { admissionEnabled: true } }, select: { id: true } }) : null;
    if (!stage) return "Choose an admission stage of this event (applications must be on).";
    return { judgingRoundId: null, mentoringRoundId: null, admissionStageId: stage.id };
  }
  return { judgingRoundId: null, mentoringRoundId: null, admissionStageId: null };
}

type Window = { claimOpensAt: Date | null; claimClosesAt: Date | null };

function windowFrom(data: SaveInput, timeZone: string): Window | string {
  const parse = (value: string) => (value ? zonedInputToIso(value, timeZone) : "");
  const opens = parse(data.claimOpensAt);
  const closes = parse(data.claimClosesAt);
  if (opens === null || closes === null) return "Check the claim window dates.";
  const window = { claimOpensAt: opens ? new Date(opens) : null, claimClosesAt: closes ? new Date(closes) : null };
  if (window.claimOpensAt && window.claimClosesAt && window.claimClosesAt <= window.claimOpensAt) return "Claims must close after they open.";
  return window;
}

/** Create a policy, or edit one. Who it is for is fixed once claims are filed under it. */
export async function savePolicy(ctx: PolicyAdminContext, input: unknown): Promise<ClaimResult<{ policyId: string }>> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the policy.");
  const data = parsed.data;
  return prisma.$transaction(async (tx) => {
    const event = await lockedEvent(tx, ctx);
    if (!event) return fail("Event not found.");
    const currency = await financeCurrency(tx, event);
    const cap = parseMoneyToMinor(data.cap, currency);
    const budget = data.budget ? parseMoneyToMinor(data.budget, currency) : null;
    if (cap == null || cap <= BigInt(0) || (data.budget && (budget == null || budget <= BigInt(0)))) return fail(`Enter amounts in ${currency}, for example 5000.`);
    const stage = await stageFor(tx, event.id, data);
    if (typeof stage === "string") return fail(stage);
    const window = windowFrom(data, safeTimeZone(event.timezone));
    if (typeof window === "string") return fail(window);
    const values = {
      name: data.name, eligibility: data.eligibility, ...stage, capPerPersonMinor: cap, budgetMinor: budget, categories: [...new Set(data.categories)], ...window,
      requireFinalistsPublished: data.eligibility === ReimbursementEligibility.JUDGING_ROUND_ENTRY && data.requireFinalistsPublished,
      crewKinds: data.eligibility === ReimbursementEligibility.CREW ? [...new Set(data.crewKinds)] : [],
      attendanceRequired: data.attendanceRequired, active: data.active, notifyWhenAvailable: data.notifyWhenAvailable,
    };
    let policyId = data.policyId;
    if (!policyId) {
      if ((await tx.reimbursementPolicy.count({ where: { eventId: event.id } })) >= MAX_POLICIES_PER_EVENT) return fail(`An event can have up to ${MAX_POLICIES_PER_EVENT} reimbursement policies.`);
      policyId = (await tx.reimbursementPolicy.create({ data: { eventId: event.id, ...values }, select: { id: true } })).id;
    } else {
      const current = await tx.reimbursementPolicy.findFirst({ where: { id: policyId, eventId: event.id }, select: { eligibility: true, judgingRoundId: true, mentoringRoundId: true, admissionStageId: true, crewKinds: true, _count: { select: { claims: true } } } });
      if (!current) return fail("Policy not found.");
      const sameKinds = [...current.crewKinds].sort().join() === [...values.crewKinds].sort().join();
      const whoChanged = current.eligibility !== values.eligibility || current.judgingRoundId !== values.judgingRoundId || current.mentoringRoundId !== values.mentoringRoundId || current.admissionStageId !== values.admissionStageId || !sameKinds;
      if (whoChanged && current._count.claims > 0) return fail("Who a policy is for is fixed once claims are filed under it. Close it and add a new policy instead.");
      await tx.reimbursementPolicy.update({ where: { id: policyId }, data: values });
    }
    // Amounts are now in this currency, as when the budget is first set.
    if (!event.currency) await tx.event.update({ where: { id: event.id }, data: { currency } });
    await recordAuditEvent({
      action: data.policyId ? "REIMBURSEMENT_POLICY_UPDATED" : "REIMBURSEMENT_POLICY_CREATED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "ReimbursementPolicy", targetId: policyId,
      metadata: { eventId: event.id, eligibility: values.eligibility, capPerPersonMinor: cap.toString(), budget: budget != null, active: values.active, notify: values.notifyWhenAvailable }, client: tx,
    });
    return ok({ policyId });
  });
}

const activeSchema = z.object({ policyId: id, active: z.boolean() }).strict();

/** Close a policy to new claims (its claims are still decided), or open it again. */
export async function setPolicyActive(ctx: PolicyAdminContext, input: unknown): Promise<ClaimResult<undefined>> {
  const parsed = activeSchema.safeParse(input);
  if (!parsed.success) return fail("Policy not found.");
  return prisma.$transaction(async (tx) => {
    const event = await lockedEvent(tx, ctx);
    const updated = event ? await tx.reimbursementPolicy.updateMany({ where: { id: parsed.data.policyId, eventId: event.id }, data: { active: parsed.data.active } }) : { count: 0 };
    if (updated.count !== 1) return fail("Policy not found.");
    await recordAuditEvent({ action: parsed.data.active ? "REIMBURSEMENT_POLICY_REOPENED" : "REIMBURSEMENT_POLICY_CLOSED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "ReimbursementPolicy", targetId: parsed.data.policyId, metadata: { eventId: ctx.eventId }, client: tx });
    return ok(undefined);
  });
}

/** Delete a policy nobody has claimed under; one with claims can only be closed. */
export async function deletePolicy(ctx: PolicyAdminContext, policyId: unknown): Promise<ClaimResult<undefined>> {
  const parsed = id.safeParse(policyId);
  if (!parsed.success) return fail("Policy not found.");
  return prisma.$transaction(async (tx) => {
    const event = await lockedEvent(tx, ctx);
    const policy = event ? await tx.reimbursementPolicy.findFirst({ where: { id: parsed.data, eventId: event.id }, select: { id: true, _count: { select: { claims: true } } } }) : null;
    if (!policy) return fail("Policy not found.");
    if (policy._count.claims > 0) return fail("Claims were filed under this policy, so it can only be closed.");
    await tx.reimbursementPolicy.delete({ where: { id: policy.id } });
    await recordAuditEvent({ action: "REIMBURSEMENT_POLICY_DELETED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "ReimbursementPolicy", targetId: policy.id, metadata: { eventId: ctx.eventId }, client: tx });
    return ok(undefined);
  });
}
