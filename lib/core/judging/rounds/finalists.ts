import "server-only";

/**
 * Publishing a round's finalists (docs/HACKATHON.md "Rounds"), separately
 * from results: the public results page shows a Finalists block, and each
 * advanced project's confirmed entrant members get one transactional
 * "finalists-announced" email, once per address and round.
 */

import { JudgingRoundEntrySource, OutboxStatus, Prisma, RsvpStatus, SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { asFinalistsAnnouncedPayload, enqueueFinalistsAnnounced, FINALISTS_ANNOUNCED_KIND, type FinalistsAnnouncedPayload } from "@/lib/outbox";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { publicWinnerDto, type PublicWinnerDto } from "@/lib/judgingDto";
import { FINALISTS_LIMIT } from "@/lib/validators/judgingRounds";
import { fail, isId, type JudgingEvent, type JudgingResult, nameSourceSelect, ok, okEmpty, personEmail, personName, personSelect, withOrganiserLock } from "../shared";
import { resolveJudgingRound } from "./scope";

const ROUND_NOT_FOUND = "Judging round not found.";

/**
 * Whether entrants are emailed about this event's judging announcements. The
 * single gate for finalist emails: a per-event switch (for example an
 * "email entrants about results" setting) belongs here.
 */
export function entrantJudgingEmailsEnabled(event: Pick<JudgingEvent, "id">): boolean {
  void event;
  return true;
}

/** One payload per address of the confirmed members of each advanced project (team members, or the solo registrant). */
async function finalistRecipients(tx: Prisma.TransactionClient, eventId: string, roundId: string, alreadyTold: Set<string>): Promise<FinalistsAnnouncedPayload[]> {
  const entries = await tx.judgingRoundEntry.findMany({
    where: { roundId, submission: { eventId, status: SubmissionStatus.SUBMITTED } },
    orderBy: [{ sourceRank: "asc" }, { submissionId: "asc" }],
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
  const seen = new Set(alreadyTold);
  const payloads: FinalistsAnnouncedPayload[] = [];
  for (const entry of entries) {
    const solo = entry.submission.rsvp?.status === RsvpStatus.CONFIRMED ? [entry.submission.rsvp] : [];
    for (const person of [...(entry.submission.team?.members ?? []), ...solo]) {
      const email = personEmail(person)?.toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      const name = personName(person)?.slice(0, 200);
      payloads.push({ to: email, eventId, roundId, submissionId: entry.submissionId, ...(name ? { recipientName: name } : {}) });
    }
  }
  return payloads;
}

/**
 * Publish an ADVANCED round's finalists: sets `finalistsPublishedAt` and
 * queues the announcement (skipping addresses already told for this round,
 * so republishing never emails anyone twice). Idempotent. Audited
 * (JUDGING_FINALISTS_PUBLISHED, counts only).
 */
export async function publishFinalists(ctx: JudgingOrganiserContext, roundId: unknown): Promise<JudgingResult<{ publishedAt: Date; queued: number }>> {
  if (!isId(roundId)) return fail(ROUND_NOT_FOUND);
  return withOrganiserLock(ctx, async (tx, event) => {
    const round = await resolveJudgingRound(tx, event, roundId);
    if (!round?.id) return fail(ROUND_NOT_FOUND);
    if (round.finalistsPublishedAt) return ok({ publishedAt: round.finalistsPublishedAt, queued: 0 });
    if (round.entrySource !== JudgingRoundEntrySource.ADVANCED) return fail("Only a round with advanced finalists can publish them.");
    const finalists = await tx.judgingRoundEntry.count({ where: { roundId: round.id, submission: { status: SubmissionStatus.SUBMITTED } } });
    if (finalists === 0) return fail("Advance finalists into this round first.");
    const publishedAt = new Date();
    await tx.judgingRound.update({ where: { id: round.id }, data: { finalistsPublishedAt: publishedAt } });
    let payloads: FinalistsAnnouncedPayload[] = [];
    if (entrantJudgingEmailsEnabled(event)) {
      const previous = await tx.outboxMessage.findMany({ where: { kind: FINALISTS_ANNOUNCED_KIND, payload: { path: ["roundId"], equals: round.id } }, select: { payload: true } });
      const told = new Set(previous.map((row) => asFinalistsAnnouncedPayload(row.payload)?.to.toLowerCase()).filter((to): to is string => Boolean(to)));
      payloads = await finalistRecipients(tx, event.id, round.id, told);
      await enqueueFinalistsAnnounced(tx, payloads);
    }
    await recordAuditEvent({
      client: tx,
      action: "JUDGING_FINALISTS_PUBLISHED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: event.id,
      metadata: { round: round.position, finalists, recipients: payloads.length },
    });
    return ok({ publishedAt, queued: payloads.length });
  });
}

/** Hide a round's finalists again; announcements not yet delivered are withdrawn. Audited. */
export async function unpublishFinalists(ctx: JudgingOrganiserContext, roundId: unknown): Promise<JudgingResult> {
  if (!isId(roundId)) return fail(ROUND_NOT_FOUND);
  return withOrganiserLock(ctx, async (tx, event) => {
    const round = await resolveJudgingRound(tx, event, roundId);
    if (!round?.id) return fail(ROUND_NOT_FOUND);
    if (!round.finalistsPublishedAt) return okEmpty();
    await tx.judgingRound.update({ where: { id: round.id }, data: { finalistsPublishedAt: null } });
    await tx.outboxMessage.deleteMany({ where: { kind: FINALISTS_ANNOUNCED_KIND, status: OutboxStatus.PENDING, payload: { path: ["roundId"], equals: round.id } } });
    await recordAuditEvent({
      client: tx,
      action: "JUDGING_FINALISTS_UNPUBLISHED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: event.id,
      metadata: { round: round.position },
    });
    return okEmpty();
  });
}

export type PublicFinalistsDto = { roundName: string; publishedAt: Date; finalists: Array<Omit<PublicWinnerDto, "place">> };

/**
 * Published finalists for the public results page, one block per round,
 * in round order: SUBMITTED projects only, titles, entrant display names and
 * links (never scores or ranks). The caller applies the event page's
 * visibility rules first.
 */
export async function loadPublicFinalists(eventId: string): Promise<PublicFinalistsDto[]> {
  if (!isId(eventId)) return [];
  const rounds = await prisma.judgingRound.findMany({
    where: { eventId, finalistsPublishedAt: { not: null }, event: { submissionsEnabled: true } },
    orderBy: { position: "asc" },
    select: {
      name: true,
      finalistsPublishedAt: true,
      entries: {
        where: { submission: { eventId, status: SubmissionStatus.SUBMITTED } },
        orderBy: [{ submission: { title: "asc" } }, { submissionId: "asc" }],
        take: FINALISTS_LIMIT,
        select: { submission: { select: { title: true, repoUrl: true, demoUrl: true, videoUrl: true, ...nameSourceSelect } } },
      },
    },
  });
  return rounds
    .filter((round) => round.entries.length > 0)
    .map((round) => ({
      roundName: round.name,
      publishedAt: round.finalistsPublishedAt!,
      finalists: round.entries.map((entry) => {
        const { place: _place, ...rest } = publicWinnerDto({ place: 1, submission: entry.submission });
        void _place;
        return rest;
      }),
    }));
}
