import "server-only";

/** Finalist announcements for a judging round (docs/HACKATHON.md "Rounds"). */

import { Prisma, SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendFinalistsAnnouncedEmail } from "@/lib/email";
import { resultsPath } from "@/lib/submissionToken";
import type { OutboxClient } from "./enqueue";
import { isBoundedString, isEmail } from "./payloads";

export const FINALISTS_ANNOUNCED_KIND = "finalists-announced";

/**
 * One email per address of an advanced project's confirmed entrant members.
 * Titles are read at send time; dropped when the finalists were unpublished,
 * the project left the round, or it is no longer SUBMITTED.
 */
export type FinalistsAnnouncedPayload = { to: string; eventId: string; roundId: string; submissionId: string; recipientName?: string };

export async function enqueueFinalistsAnnounced(client: OutboxClient, payloads: FinalistsAnnouncedPayload[]) {
  if (payloads.length === 0) return { count: 0 };
  return client.outboxMessage.createMany({ data: payloads.map((payload) => ({ kind: FINALISTS_ANNOUNCED_KIND, payload: payload as Prisma.InputJsonValue })) });
}

export function asFinalistsAnnouncedPayload(value: Prisma.JsonValue): FinalistsAnnouncedPayload | null {
  const p = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!p || !isEmail(p.to) || !isBoundedString(p.eventId, 64) || !isBoundedString(p.roundId, 64) || !isBoundedString(p.submissionId, 64)) return null;
  if (p.recipientName !== undefined && !isBoundedString(p.recipientName, 200)) return null;
  return p as FinalistsAnnouncedPayload;
}

export async function finalistsMessageOrganisation(payload: Record<string, unknown>): Promise<string | null> {
  if (typeof payload.eventId !== "string") return null;
  return (await prisma.event.findUnique({ where: { id: payload.eventId }, select: { organisationId: true } }))?.organisationId ?? null;
}

export async function deliverFinalistsAnnounced(value: Prisma.JsonValue, messageId: string): Promise<"sent" | "dropped" | null> {
  const payload = asFinalistsAnnouncedPayload(value);
  if (!payload) return null;
  const entry = await prisma.judgingRoundEntry.findUnique({
    where: { roundId_submissionId: { roundId: payload.roundId, submissionId: payload.submissionId } },
    select: {
      round: { select: { name: true, eventId: true, finalistsPublishedAt: true } },
      submission: { select: { title: true, status: true, event: { select: { title: true, slug: true, organisation: { select: { slug: true } } } } } },
    },
  });
  if (!entry || entry.round.eventId !== payload.eventId || !entry.round.finalistsPublishedAt || entry.submission.status !== SubmissionStatus.SUBMITTED) return "dropped";
  const event = entry.submission.event;
  await sendFinalistsAnnouncedEmail({
    to: payload.to,
    eventTitle: event.title,
    roundName: entry.round.name,
    projectTitle: entry.submission.title,
    resultsPath: resultsPath(event.organisation.slug, event.slug),
    recipientName: payload.recipientName,
    messageId,
  });
  return "sent";
}
