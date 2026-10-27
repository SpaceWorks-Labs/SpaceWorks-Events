import "server-only";

import { OutboxStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { RESULTS_PUBLISHED_KIND } from "./judging";
import { EVENT_REMINDER_KIND } from "./payloads";

/**
 * Kinds an organiser sends to a whole audience at once (thousands of rows in
 * one click). They wait behind every other kind, so a large send never delays
 * a password reset, sign-in code, ticket, payment receipt or team email
 * queued after it. Event reminders (one per guest, queued by the beat) wait
 * too. Operator notices stay urgent: sign-in alerts and password notices use
 * that kind.
 */
export const BULK_OUTBOX_KINDS: readonly string[] = ["event-broadcast", "event-invite", RESULTS_PUBLISHED_KIND, EVENT_REMINDER_KIND];

/** Due messages, oldest first: transactional kinds before bulk ones. */
export async function dueOutboxMessages(take: number) {
  const due = { status: OutboxStatus.PENDING, availableAt: { lte: new Date() } };
  const urgent = await prisma.outboxMessage.findMany({
    where: { ...due, kind: { notIn: [...BULK_OUTBOX_KINDS] } },
    orderBy: { createdAt: "asc" },
    take,
  });
  if (urgent.length >= take) return urgent;
  const bulk = await prisma.outboxMessage.findMany({
    where: { ...due, kind: { in: [...BULK_OUTBOX_KINDS] } },
    orderBy: { createdAt: "asc" },
    take: take - urgent.length,
  });
  const seen = new Set(urgent.map((message) => message.id));
  return [...urgent, ...bulk.filter((message) => !seen.has(message.id))];
}
