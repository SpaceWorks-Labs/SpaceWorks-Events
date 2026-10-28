import "server-only";

/**
 * The results announcement (`results-published` emails): who it goes to,
 * queuing it, "Send results email now", and the dialogs' recipient count.
 * Opt-in per event (`Event.emailEntrantsOnResults`, lib/hackathonEmails.ts).
 */

import { Prisma, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { asResultsPublishedPayload, enqueueResultsPublished } from "@/lib/outbox";
import { announcementCoversPublication, sendResultsAnnouncementRefusal } from "@/lib/hackathonEmails";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import { CHANGED, fail, type JudgingResult, ok, personEmail, personName, personSelect, withOrganiserLock } from "./shared";

/**
 * Plan the `results-published` emails: one per confirmed entrant member
 * (crew places excluded),
 * deduplicated by lower-cased address. After an earlier announcement
 * (`firstAnnouncement` false), only addresses whose copy was withdrawn
 * undelivered by an unpublish are emailed: anyone with a delivered (or
 * in-flight) announcement left in the outbox is skipped, and once those rows
 * have aged out nobody is emailed again. Addresses that already have an
 * announcement row for this event are never planned twice.
 */
async function planResultsAnnouncement(
  tx: Prisma.TransactionClient,
  eventId: string,
  firstAnnouncement: boolean,
): Promise<Array<{ to: string; eventId: string; recipientName?: string }>> {
  const previous = await tx.outboxMessage.findMany({
    where: { kind: "results-published", payload: { path: ["eventId"], equals: eventId } },
    select: { payload: true },
  });
  const alreadyTold = new Set(previous.map((row) => asResultsPublishedPayload(row.payload)?.to.toLowerCase()).filter((to): to is string => Boolean(to)));
  if (!firstAnnouncement && alreadyTold.size === 0) return [];
  const recipients = await tx.rSVP.findMany({
    // Entrants only: crew places (docs/CREW.md) are never told about results.
    where: { eventId, status: RsvpStatus.CONFIRMED, isCrew: false },
    select: personSelect,
    orderBy: { createdAt: "asc" },
  });
  const seen = new Set<string>(alreadyTold);
  const payloads: Array<{ to: string; eventId: string; recipientName?: string }> = [];
  for (const person of recipients) {
    const email = personEmail(person)?.toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const name = personName(person)?.slice(0, 200);
    payloads.push({ to: email, eventId, ...(name ? { recipientName: name } : {}) });
  }
  return payloads;
}

/** Queue the planned announcement in the caller's transaction (which holds the Event lock); returns how many. */
export async function queueResultsAnnouncement(tx: Prisma.TransactionClient, eventId: string, firstAnnouncement: boolean): Promise<number> {
  const payloads = await planResultsAnnouncement(tx, eventId, firstAnnouncement);
  await enqueueResultsPublished(tx, payloads);
  return payloads.length;
}

export type SendResultsAnnouncementOutcome = { queued: number; alreadyAnnounced: boolean; announcedAt: Date };

/**
 * "Send results email now": results were published with the email switch
 * off, the organiser has since turned it on, and this publication hasn't
 * been announced (`resultsAnnouncedAt` is null, or older than
 * `resultsPublishedAt` after an unpublish that withdrew some copies). Queues
 * the `results-published` emails to every confirmed entrant not already
 * holding one for this event, once, and sets `resultsAnnouncedAt`. Same
 * permission as publishing (`canManageJudging`: organisation owners and
 * admins, resolved by the caller). Idempotent under concurrency: the Event
 * row lock (`FOR UPDATE`) serialises callers, and a later call sees the
 * publication covered and queues nothing. Audited (JUDGING_RESULTS_ANNOUNCED).
 */
export async function sendResultsAnnouncement(ctx: JudgingOrganiserContext): Promise<JudgingResult<SendResultsAnnouncementOutcome>> {
  return withOrganiserLock<SendResultsAnnouncementOutcome>(ctx, async (tx, event) => {
    const refusal = sendResultsAnnouncementRefusal(event);
    if (refusal) return fail(refusal);
    if (event.resultsAnnouncedAt && announcementCoversPublication(event)) return ok({ queued: 0, alreadyAnnounced: true, announcedAt: event.resultsAnnouncedAt });
    const publishedAt = event.resultsPublishedAt!;
    const now = new Date();
    // Never earlier than the publication, so it counts as covering it.
    const announcedAt = now < publishedAt ? publishedAt : now;
    const updated = await tx.event.updateMany({
      where: { id: event.id, resultsPublishedAt: publishedAt, resultsAnnouncedAt: event.resultsAnnouncedAt },
      data: { resultsAnnouncedAt: announcedAt },
    });
    if (updated.count !== 1) return fail(CHANGED);
    const queued = await queueResultsAnnouncement(tx, event.id, !event.resultsAnnouncedAt);
    await recordAuditEvent({
      client: tx,
      action: "JUDGING_RESULTS_ANNOUNCED",
      actorUserId: ctx.userId,
      organisationId: ctx.organisationId,
      targetType: "Event",
      targetId: event.id,
      metadata: { recipients: queued, announcedBefore: Boolean(event.resultsAnnouncedAt) },
    });
    return ok({ queued, alreadyAnnounced: false, announcedAt });
  });
}

/**
 * How many entrants a results announcement would email right now: what the
 * publish confirmation (switch on) and "Send results email now" show. Counted
 * in SQL with the same rules as `planResultsAnnouncement` (confirmed
 * non-crew registrations, the account email else the guest email, trimmed and
 * lower-cased, distinct, minus addresses already holding an announcement for
 * this event; none after an announcement whose rows are all gone). Null
 * without the organiser's event.
 */
export async function countResultsAnnouncementRecipients(ctx: JudgingOrganiserContext): Promise<number | null> {
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: { id: true, resultsAnnouncedAt: true } });
  if (!event) return null;
  if (event.resultsAnnouncedAt) {
    const previous = await prisma.outboxMessage.count({ where: { kind: "results-published", payload: { path: ["eventId"], equals: event.id } } });
    if (previous === 0) return 0;
  }
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT s."email") AS "count"
    FROM (
      SELECT lower(COALESCE(NULLIF(btrim(u."email"), ''), NULLIF(btrim(r."guestEmail"), ''))) AS "email"
      FROM "RSVP" r
      LEFT JOIN "User" u ON u."id" = r."userId"
      WHERE r."eventId" = ${event.id} AND r."status" = 'CONFIRMED' AND r."isCrew" = false
    ) s
    WHERE s."email" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "OutboxMessage" m
        WHERE m."kind" = 'results-published'
          AND m."payload"->>'eventId' = ${event.id}
          AND lower(m."payload"->>'to') = s."email"
      )`;
  return Number(rows[0]?.count ?? 0);
}
