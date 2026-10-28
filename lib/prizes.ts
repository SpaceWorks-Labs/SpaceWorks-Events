import "server-only";

import { OfflinePaymentMethod, type Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { DEFAULT_CURRENCY, formatMoney, parseMoneyToMinor } from "@/lib/payments/money";
import { awardEligibleWhere } from "@/lib/core/judging/rounds/awardEligibility";

/**
 * Prize money for hackathon awards (docs/HACKATHON.md). An award may carry a
 * prize per winner; owners and admins record each payout made by hand (cash,
 * UPI, bank transfer) in PrizePayout, an append-only ledger guarded by the
 * database. A mistake is undone with a reversal row, never an edit.
 */

export type PrizeContext = { organisationId: string; eventId: string; userId: string; };
export type PrizeResult = { ok: true; } | { ok: false; error: string; };

const id = z.string().trim().min(1).max(128);
export const awardPrizeSchema = z.object({ awardId: id, prize: z.string().trim().max(20).default("") }).strict();
export const prizePayoutSchema = z.object({
  awardId: id,
  submissionId: id,
  recipientName: z.string().trim().min(1, "Say who was paid.").max(120),
  amount: z.string().trim().min(1, "Enter the amount paid.").max(20),
  method: z.nativeEnum(OfflinePaymentMethod),
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).default(""),
  /** The day it was paid (YYYY-MM-DD), defaulting to today. */
  paidOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
export const reversePayoutSchema = z.object({ payoutId: id, reason: z.string().trim().min(1, "Say why it is reversed.").max(500) }).strict();

const ZERO = BigInt(0);

async function lockEvent(tx: Prisma.TransactionClient, ctx: PrizeContext) {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${ctx.eventId} FOR UPDATE`;
  return tx.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: { id: true, title: true, currency: true } });
}

async function eventCurrency(tx: Prisma.TransactionClient, event: { currency: string | null; }, organisationId: string) {
  if (event.currency) return event.currency;
  const settings = await tx.organisationPaymentSettings.findUnique({ where: { organisationId }, select: { currency: true } });
  return settings?.currency ?? DEFAULT_CURRENCY;
}

/** Net paid to one winner of one award: payouts less their reversals. */
async function netPaid(tx: Prisma.TransactionClient, awardId: string, submissionId: string) {
  const rows = await tx.prizePayout.findMany({ where: { awardId, submissionId }, select: { amountMinor: true, reversesId: true } });
  return rows.reduce((sum, row) => (row.reversesId ? sum - row.amountMinor : sum + row.amountMinor), ZERO);
}

/** Set or clear an award's prize per winner. The event's currency is set with its first price. */
export async function setAwardPrize(ctx: PrizeContext, input: unknown): Promise<PrizeResult> {
  const parsed = awardPrizeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the prize." };
  return prisma.$transaction(async (tx): Promise<PrizeResult> => {
    const event = await lockEvent(tx, ctx);
    if (!event) return { ok: false, error: "Event not found." };
    const currency = await eventCurrency(tx, event, ctx.organisationId);
    const prizeMinor = parsed.data.prize ? parseMoneyToMinor(parsed.data.prize, currency) : ZERO;
    if (prizeMinor === null) return { ok: false, error: `Enter the prize in ${currency}, for example 10000.` };
    const updated = await tx.eventAward.updateMany({ where: { id: parsed.data.awardId, eventId: event.id }, data: { prizeMinor: prizeMinor > ZERO ? prizeMinor : null } });
    if (updated.count !== 1) return { ok: false, error: "Award not found." };
    if (prizeMinor > ZERO && !event.currency) await tx.event.update({ where: { id: event.id }, data: { currency } });
    await recordAuditEvent({ action: "AWARD_PRIZE_UPDATED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "EventAward", targetId: parsed.data.awardId, metadata: { prizeMinor: prizeMinor.toString() }, client: tx });
    return { ok: true };
  });
}

/**
 * Record prize money paid to a winner. Never more than the award's prize, when
 * it has one, and only to a winner the final round allows (a finalist when it
 * takes advanced finalists; lib/core/judging/rounds/awardEligibility.ts).
 */
export async function recordPrizePayout(ctx: PrizeContext, input: unknown): Promise<PrizeResult> {
  const parsed = prizePayoutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the payout." };
  const data = parsed.data;
  const paidAt = data.paidOn ? new Date(`${data.paidOn}T12:00:00Z`) : new Date();
  if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + 86_400_000) return { ok: false, error: "Choose the day it was paid, today or earlier." };
  return prisma.$transaction(async (tx): Promise<PrizeResult> => {
    const event = await lockEvent(tx, ctx);
    if (!event) return { ok: false, error: "Event not found." };
    const winner = await tx.eventAwardWinner.findFirst({
      where: { awardId: data.awardId, submissionId: data.submissionId, award: { eventId: event.id }, submission: await awardEligibleWhere(tx, event.id) },
      select: { award: { select: { name: true, prizeMinor: true } }, submission: { select: { title: true } } },
    });
    if (!winner) return { ok: false, error: "That project hasn't won this award." };
    const currency = await eventCurrency(tx, event, ctx.organisationId);
    const amountMinor = parseMoneyToMinor(data.amount, currency);
    if (amountMinor === null || amountMinor <= ZERO) return { ok: false, error: `Enter the amount in ${currency}, for example 5000.` };
    const prize = winner.award.prizeMinor;
    if (prize != null && (await netPaid(tx, data.awardId, data.submissionId)) + amountMinor > prize) {
      return { ok: false, error: `That would pay more than the prize of ${formatMoney(prize, currency)}.` };
    }
    const payout = await tx.prizePayout.create({
      data: {
        organisationId: ctx.organisationId, eventId: event.id, awardId: data.awardId, submissionId: data.submissionId,
        awardName: winner.award.name.slice(0, 80), projectTitle: winner.submission.title.slice(0, 120), recipientName: data.recipientName,
        amountMinor, currency, method: data.method, reference: data.reference || null, note: data.note, paidAt, recordedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAuditEvent({ action: "PRIZE_PAYOUT_RECORDED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "PrizePayout", targetId: payout.id, metadata: { eventId: event.id, amountMinor: amountMinor.toString(), method: data.method }, client: tx });
    await notifyChat(tx, ctx.organisationId, "payout", `Prize paid: ${formatMoney(amountMinor, currency)} to ${data.recipientName} for ${winner.award.name} (${event.title}).`);
    return { ok: true };
  });
}

/** Undo a payout with a reversal row for the same amount; the original stays on record. */
export async function reversePrizePayout(ctx: PrizeContext, input: unknown): Promise<PrizeResult> {
  const parsed = reversePayoutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the reversal." };
  return prisma.$transaction(async (tx): Promise<PrizeResult> => {
    const event = await lockEvent(tx, ctx);
    if (!event) return { ok: false, error: "Event not found." };
    const original = await tx.prizePayout.findFirst({ where: { id: parsed.data.payoutId, eventId: event.id, organisationId: ctx.organisationId, reversesId: null } });
    if (!original) return { ok: false, error: "Payout not found." };
    if (await tx.prizePayout.count({ where: { reversesId: original.id } }) > 0) return { ok: false, error: "This payout is already reversed." };
    const reversal = await tx.prizePayout.create({
      data: {
        organisationId: original.organisationId, eventId: original.eventId, awardId: original.awardId, submissionId: original.submissionId,
        awardName: original.awardName, projectTitle: original.projectTitle, recipientName: original.recipientName, amountMinor: original.amountMinor,
        currency: original.currency, method: original.method, reference: original.reference, note: parsed.data.reason, paidAt: new Date(),
        reversesId: original.id, recordedByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAuditEvent({ action: "PRIZE_PAYOUT_REVERSED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "PrizePayout", targetId: reversal.id, metadata: { reverses: original.id }, client: tx });
    await notifyChat(tx, ctx.organisationId, "payout", `Prize payout reversed: ${formatMoney(original.amountMinor, original.currency)} to ${original.recipientName} (${event.title}).`);
    return { ok: true };
  });
}
