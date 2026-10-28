import "server-only";

/** Finalist announcements for a judging round (docs/HACKATHON.md "Rounds"). */

import { Prisma, SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendFinalistsAnnouncedEmail } from "@/lib/email";
import { resultsPath } from "@/lib/submissionToken";
import { isBoundedString, isEmail } from "./payloads";

export const FINALISTS_ANNOUNCED_KIND = "finalists-announced";

/**
 * One email per address of the advanced projects' confirmed entrant
 * members, listing every finalist project of theirs. Titles are read at send
 * time; projects that left the round or are no longer SUBMITTED are left out,
 * and the message is dropped when none is left or the finalists were
 * unpublished.
 */
export type FinalistsAnnouncedPayload = { to: string; eventId: string; roundId: string; submissionIds: string[]; recipientName?: string };

export function asFinalistsAnnouncedPayload(value: Prisma.JsonValue): FinalistsAnnouncedPayload | null {
  const p = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!p || !isEmail(p.to) || !isBoundedString(p.eventId, 64) || !isBoundedString(p.roundId, 64)) return null;
  if (!Array.isArray(p.submissionIds) || p.submissionIds.length === 0 || p.submissionIds.length > 50 || !p.submissionIds.every((id) => isBoundedString(id, 64))) return null;
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
  const round = await prisma.judgingRound.findUnique({
    where: { id: payload.roundId },
    select: {
      name: true,
      eventId: true,
      finalistsPublishedAt: true,
      event: { select: { title: true, slug: true, organisation: { select: { slug: true } } } },
      entries: { where: { submissionId: { in: payload.submissionIds }, submission: { status: SubmissionStatus.SUBMITTED } }, select: { submission: { select: { title: true } } } },
    },
  });
  if (!round || round.eventId !== payload.eventId || !round.finalistsPublishedAt || round.entries.length === 0) return "dropped";
  await sendFinalistsAnnouncedEmail({
    to: payload.to,
    eventTitle: round.event.title,
    roundName: round.name,
    projectTitles: round.entries.map((entry) => entry.submission.title).sort((a, b) => a.localeCompare(b)),
    resultsPath: resultsPath(round.event.organisation.slug, round.event.slug),
    recipientName: payload.recipientName,
    messageId,
  });
  return "sent";
}
