import "server-only";

/**
 * Publishing a round's finalists (docs/HACKATHON.md "Rounds"), separately
 * from results: the public results page shows a Finalists block
 * (./publicFinalists.ts) and, when the event emails entrants about results
 * (`Event.emailEntrantsOnResults`, off by default), each confirmed entrant
 * member of an advanced project gets one transactional "finalists-announced"
 * email listing all their finalist projects, once per round. Who was told is
 * recorded durably (JudgingFinalistNotice), never read back from outbox rows
 * that retention deletes.
 */

import { createHash } from "node:crypto";
import { JudgingRoundEntrySource, OutboxStatus, Prisma, RsvpStatus, SubmissionStatus } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import { shouldEmailOnPublish } from "@/lib/hackathonEmails";
import { FINALISTS_ANNOUNCED_KIND, type FinalistsAnnouncedPayload } from "@/lib/outbox";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { fail, isId, type JudgingEvent, type JudgingResult, ok, okEmpty, personEmail, personName, personSelect, withOrganiserLock } from "../shared";
import { resolveJudgingRound } from "./scope";

const ROUND_NOT_FOUND = "Judging round not found.";

/**
 * Whether entrants are emailed about this event's finalists: the same opt-in
 * as the results announcement (`Event.emailEntrantsOnResults`, off by
 * default). The single gate for finalist emails.
 */
export function entrantJudgingEmailsEnabled(event: Pick<JudgingEvent, "emailEntrantsOnResults">): boolean {
  return shouldEmailOnPublish(event);
}

/** SHA-256 of the lowercased address: the notice key (the address itself is never stored there). */
export function finalistEmailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** One payload per address of the advanced projects' confirmed members (team members, or the solo registrant), listing every finalist project of theirs. */
async function finalistRecipients(tx: Prisma.TransactionClient, eventId: string, roundId: string): Promise<FinalistsAnnouncedPayload[]> {
  const entries = await tx.judgingRoundEntry.findMany({
    where: { roundId, submission: { eventId, status: SubmissionStatus.SUBMITTED } },
    orderBy: [{ sourceRank: { sort: "asc", nulls: "last" } }, { submissionId: "asc" }],
    select: {
      submissionId: true,
      submission: {
        select: {
          team: { select: { members: { where: { status: RsvpStatus.CONFIRMED }, orderBy: { createdAt: "asc" }, select: personSelect } } },
          rsvp: { select: { status: true, ...personSelect } },
        },
      },
    },
  });
  const byEmail = new Map<string, FinalistsAnnouncedPayload>();
  for (const entry of entries) {
    const solo = entry.submission.rsvp?.status === RsvpStatus.CONFIRMED ? [entry.submission.rsvp] : [];
    for (const person of [...(entry.submission.team?.members ?? []), ...solo]) {
      const email = personEmail(person)?.toLowerCase();
      if (!email) continue;
      const known = byEmail.get(email);
      if (known) {
        if (!known.submissionIds.includes(entry.submissionId)) known.submissionIds.push(entry.submissionId);
        continue;
      }
      const name = personName(person)?.slice(0, 200);
      byEmail.set(email, { to: email, eventId, roundId, submissionIds: [entry.submissionId], ...(name ? { recipientName: name } : {}) });
    }
  }
  return [...byEmail.values()];
}

/** Queue the announcement for everyone not yet told about this round, recording each recipient. Returns how many were queued. */
async function announceFinalists(tx: Prisma.TransactionClient, eventId: string, roundId: string): Promise<number> {
  const told = new Set((await tx.judgingFinalistNotice.findMany({ where: { roundId }, select: { emailHash: true } })).map((row) => row.emailHash));
  let queued = 0;
  for (const payload of await finalistRecipients(tx, eventId, roundId)) {
    const emailHash = finalistEmailHash(payload.to);
    if (told.has(emailHash)) continue;
    const message = await tx.outboxMessage.create({ data: { kind: FINALISTS_ANNOUNCED_KIND, payload: payload as Prisma.InputJsonValue }, select: { id: true } });
    await tx.judgingFinalistNotice.create({ data: { roundId, emailHash, outboxMessageId: message.id } });
    queued += 1;
  }
  return queued;
}

/**
 * Publish an ADVANCED round's finalists: sets `finalistsPublishedAt` and,
 * when the event emails entrants, queues the announcement for those not yet
 * told about this round. Idempotent. Audited (JUDGING_FINALISTS_PUBLISHED,
 * counts only).
 */
export async function publishFinalists(ctx: JudgingOrganiserContext, roundId: unknown): Promise<JudgingResult<{ publishedAt: Date; queued: number; emailed: boolean }>> {
  if (!isId(roundId)) return fail(ROUND_NOT_FOUND);
  return withOrganiserLock(ctx, async (tx, event) => {
    const round = await resolveJudgingRound(tx, event, roundId);
    if (!round?.id) return fail(ROUND_NOT_FOUND);
    const emailed = entrantJudgingEmailsEnabled(event);
    if (round.finalistsPublishedAt) return ok({ publishedAt: round.finalistsPublishedAt, queued: 0, emailed: false });
    if (round.entrySource !== JudgingRoundEntrySource.ADVANCED) return fail("Only a round with advanced finalists can publish them.");
    const finalists = await tx.judgingRoundEntry.count({ where: { roundId: round.id, submission: { status: SubmissionStatus.SUBMITTED } } });
    if (finalists === 0) return fail("Advance finalists into this round first.");
    const publishedAt = new Date();
    await tx.judgingRound.update({ where: { id: round.id }, data: { finalistsPublishedAt: publishedAt } });
    const queued = emailed ? await announceFinalists(tx, event.id, round.id) : 0;
    await recordAuditEvent({
      client: tx,
      action: "JUDGING_FINALISTS_PUBLISHED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: event.id,
      metadata: { round: round.position, finalists, recipients: queued, emailEntrantsOnResults: emailed },
    });
    return ok({ publishedAt, queued, emailed });
  });
}

/**
 * Hide a round's finalists again. Announcements not yet delivered are
 * withdrawn and their recipients forgotten, so a republication emails them;
 * anyone whose copy went out is never emailed again. Audited.
 */
export async function unpublishFinalists(ctx: JudgingOrganiserContext, roundId: unknown): Promise<JudgingResult> {
  if (!isId(roundId)) return fail(ROUND_NOT_FOUND);
  return withOrganiserLock(ctx, async (tx, event) => {
    const round = await resolveJudgingRound(tx, event, roundId);
    if (!round?.id) return fail(ROUND_NOT_FOUND);
    if (!round.finalistsPublishedAt) return okEmpty();
    await tx.judgingRound.update({ where: { id: round.id }, data: { finalistsPublishedAt: null } });
    // Withdraw exactly the rows still pending (one statement, so a row the worker claims meanwhile is kept and its recipient stays told).
    const withdrawn = await tx.$queryRaw<Array<{ id: string }>>`
      DELETE FROM "OutboxMessage"
      WHERE "kind" = ${FINALISTS_ANNOUNCED_KIND} AND "status" = ${OutboxStatus.PENDING}::"OutboxStatus" AND "payload"->>'roundId' = ${round.id}
      RETURNING "id"`;
    const ids = withdrawn.map((row) => row.id);
    if (ids.length) await tx.judgingFinalistNotice.deleteMany({ where: { roundId: round.id, outboxMessageId: { in: ids } } });
    await recordAuditEvent({
      client: tx,
      action: "JUDGING_FINALISTS_UNPUBLISHED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: event.id,
      metadata: { round: round.position, withdrawn: ids.length },
    });
    return okEmpty();
  });
}
