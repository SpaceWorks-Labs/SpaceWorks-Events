import "server-only";

/** Organiser moderation: disqualify a submitted project or reinstate it. Both audited. */

import { OrderStatus, SubmissionStatus } from "@prisma/client";
import { refundWholeOrderTx, submitRefunds } from "@/lib/payments/operations";
import { recordAuditEvent } from "@/lib/audit";
import { entryFeePaid } from "@/lib/payments/entryFees";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { disqualifySubmissionSchema } from "@/lib/validators";
import { fail, invalid, isId, type JudgingResult, NOT_FOUND, okEmpty, withOrganiserLock } from "./shared";

/** Disqualify a SUBMITTED project with an organiser-only reason. Removes its awards. Audited. */
export async function disqualifySubmission(ctx: JudgingOrganiserContext, input: unknown): Promise<JudgingResult> {
  const parsed = disqualifySubmissionSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const refundIds: string[] = [];
  const result = await withOrganiserLock(ctx, async (tx, event) => {
    const updated = await tx.submission.updateMany({
      where: { id: parsed.data.submissionId, eventId: event.id, status: SubmissionStatus.SUBMITTED },
      data: { status: SubmissionStatus.DISQUALIFIED, disqualifiedReason: parsed.data.reason },
    });
    if (updated.count !== 1) return fail("Only submitted projects can be disqualified.");
    await tx.eventAwardWinner.deleteMany({ where: { submissionId: parsed.data.submissionId } });
    // The reason is organiser free text; it stays out of audit metadata.
    await recordAuditEvent({
      client: tx,
      action: "SUBMISSION_DISQUALIFIED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Submission",
      targetId: parsed.data.submissionId,
      metadata: { eventId: event.id },
    });
    // The entry fee comes back in full when the event is set to refund it.
    const settings = await tx.event.findUnique({ where: { id: event.id }, select: { submissionFeeRefundOnDisqualify: true } });
    if (settings?.submissionFeeRefundOnDisqualify) {
      const paid = await tx.order.findMany({ where: { submissionId: parsed.data.submissionId, status: OrderStatus.CONFIRMED, totalMinor: { gt: 0 } }, select: { id: true } });
      for (const order of paid) refundIds.push(...(await refundWholeOrderTx(tx, { orderId: order.id, reason: "Project disqualified", actorUserId: ctx.userId })));
    }
    return okEmpty();
  });
  await submitRefunds(refundIds);
  return result;
}

export const REFUNDED_FEE_REFUSAL = "This project's entry fee was refunded when it was disqualified, so it can't be reinstated: it would stand unpaid.";

/** Undo a disqualification: back to SUBMITTED, reason cleared. Refused once its entry fee was refunded. Audited. */
export async function reinstateSubmission(ctx: JudgingOrganiserContext, submissionId: string): Promise<JudgingResult> {
  if (!isId(submissionId)) return fail(NOT_FOUND);
  return withOrganiserLock(ctx, async (tx, event) => {
    // A fee refunded on disqualification would leave the project submitted unpaid.
    const feeOrders = await tx.order.count({ where: { submissionId, eventId: event.id, status: OrderStatus.CONFIRMED, totalMinor: { gt: 0 } } });
    if (feeOrders > 0 && !(await entryFeePaid(tx, submissionId))) return fail(REFUNDED_FEE_REFUSAL);
    const updated = await tx.submission.updateMany({
      where: { id: submissionId, eventId: event.id, status: SubmissionStatus.DISQUALIFIED },
      data: { status: SubmissionStatus.SUBMITTED, disqualifiedReason: null },
    });
    if (updated.count !== 1) return fail("Only disqualified projects can be reinstated.");
    await recordAuditEvent({
      client: tx,
      action: "SUBMISSION_REINSTATED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Submission",
      targetId: submissionId,
      metadata: { eventId: event.id },
    });
    return okEmpty();
  });
}
