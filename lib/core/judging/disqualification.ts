import "server-only";

/** Organiser moderation: disqualify a submitted project or reinstate it. Both audited. */

import { SubmissionStatus } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { disqualifySubmissionSchema } from "@/lib/validators";
import { fail, invalid, isId, type JudgingResult, NOT_FOUND, okEmpty, withOrganiserLock } from "./shared";

/** Disqualify a SUBMITTED project with an organiser-only reason. Removes its awards. Audited. */
export async function disqualifySubmission(ctx: JudgingOrganiserContext, input: unknown): Promise<JudgingResult> {
  const parsed = disqualifySubmissionSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return withOrganiserLock(ctx, async (tx, event) => {
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
    return okEmpty();
  });
}

/** Undo a disqualification: back to SUBMITTED, reason cleared. Audited. */
export async function reinstateSubmission(ctx: JudgingOrganiserContext, submissionId: string): Promise<JudgingResult> {
  if (!isId(submissionId)) return fail(NOT_FOUND);
  return withOrganiserLock(ctx, async (tx, event) => {
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
