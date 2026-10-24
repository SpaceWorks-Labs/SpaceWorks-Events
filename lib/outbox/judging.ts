import "server-only";

/** Hackathon email (docs/HACKATHON.md): submission confirmations, solo submission links and results announcements. */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendResultsPublishedEmail, sendSubmissionLinkEmail, sendSubmissionReceivedEmail } from "@/lib/email";
import { hashSubmissionLinkToken, isSubmissionTokenShape, resultsPath, submissionLinkPath } from "@/lib/submissionToken";
import type { OutboxClient } from "./enqueue";
import { isBoundedString, isEmail } from "./payloads";

export const SUBMISSION_RECEIVED_KIND = "submission-received";
export const SUBMISSION_LINK_KIND = "submission-link";
export const RESULTS_PUBLISHED_KIND = "results-published";

/**
 * Hackathon submission confirmation to the person who submitted. Event and
 * project titles are read at send time; the message is dropped when the
 * submission is gone or no longer SUBMITTED.
 */
export type SubmissionReceivedPayload = { to: string; submissionId: string; recipientName?: string };

/**
 * A solo registrant's `/submit/{token}` link, sent only to the RSVP's own
 * address. Carries the raw token (a capability), which exists nowhere else;
 * dropped when the link was regenerated or the registration removed.
 */
export type SubmissionLinkPayload = { to: string; rsvpId: string; token: string };

/** Results announcement per confirmed entrant member; dropped if results were unpublished before delivery. */
export type ResultsPublishedPayload = { to: string; eventId: string; recipientName?: string };

export async function enqueueSubmissionReceived(client: OutboxClient, payload: SubmissionReceivedPayload) {
  return client.outboxMessage.create({ data: { kind: SUBMISSION_RECEIVED_KIND, payload: payload as Prisma.InputJsonValue } });
}

export async function enqueueSubmissionLink(client: OutboxClient, payload: SubmissionLinkPayload) {
  return client.outboxMessage.create({ data: { kind: SUBMISSION_LINK_KIND, payload: payload as Prisma.InputJsonValue } });
}

export async function enqueueResultsPublished(client: OutboxClient, payloads: ResultsPublishedPayload[]) {
  if (payloads.length === 0) return { count: 0 };
  return client.outboxMessage.createMany({ data: payloads.map((payload) => ({ kind: RESULTS_PUBLISHED_KIND, payload: payload as Prisma.InputJsonValue })) });
}

const asRecord = (value: Prisma.JsonValue) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);

export function asSubmissionReceivedPayload(value: Prisma.JsonValue): SubmissionReceivedPayload | null {
  const p = asRecord(value);
  if (!p || !isEmail(p.to) || !isBoundedString(p.submissionId, 64) || (p.recipientName !== undefined && !isBoundedString(p.recipientName, 200))) return null;
  return p as SubmissionReceivedPayload;
}

export function asSubmissionLinkPayload(value: Prisma.JsonValue): SubmissionLinkPayload | null {
  const p = asRecord(value);
  if (!p || !isEmail(p.to) || !isBoundedString(p.rsvpId, 64) || !isSubmissionTokenShape(p.token)) return null;
  return p as SubmissionLinkPayload;
}

export function asResultsPublishedPayload(value: Prisma.JsonValue): ResultsPublishedPayload | null {
  const p = asRecord(value);
  if (!p || !isEmail(p.to) || !isBoundedString(p.eventId, 64) || (p.recipientName !== undefined && !isBoundedString(p.recipientName, 200))) return null;
  return p as ResultsPublishedPayload;
}

export function isJudgingMessageKind(kind: string) {
  return kind === SUBMISSION_RECEIVED_KIND || kind === SUBMISSION_LINK_KIND || kind === RESULTS_PUBLISHED_KIND;
}

/** The organisation a hackathon message is sent as. */
export async function judgingMessageOrganisation(kind: string, payload: Record<string, unknown>): Promise<string | null> {
  if (kind === SUBMISSION_RECEIVED_KIND && typeof payload.submissionId === "string") {
    return (await prisma.submission.findUnique({ where: { id: payload.submissionId }, select: { event: { select: { organisationId: true } } } }))?.event.organisationId ?? null;
  }
  if (kind === SUBMISSION_LINK_KIND && typeof payload.rsvpId === "string") {
    return (await prisma.rSVP.findUnique({ where: { id: payload.rsvpId }, select: { event: { select: { organisationId: true } } } }))?.event?.organisationId ?? null;
  }
  if (kind === RESULTS_PUBLISHED_KIND && typeof payload.eventId === "string") {
    return (await prisma.event.findUnique({ where: { id: payload.eventId }, select: { organisationId: true } }))?.organisationId ?? null;
  }
  return null;
}

/**
 * Sends one hackathon message. "dropped" means it no longer applies and must
 * not be retried; null is an invalid payload, which the worker treats as permanent.
 */
export async function deliverJudgingMessage(kind: string, value: Prisma.JsonValue, messageId: string): Promise<"sent" | "dropped" | null> {
  if (kind === SUBMISSION_RECEIVED_KIND) {
    const payload = asSubmissionReceivedPayload(value);
    if (!payload) return null;
    const submission = await prisma.submission.findUnique({
      where: { id: payload.submissionId },
      select: { status: true, title: true, team: { select: { name: true } }, event: { select: { title: true, slug: true, organisation: { select: { slug: true } } } } },
    });
    if (!submission || submission.status !== "SUBMITTED") return "dropped";
    await sendSubmissionReceivedEmail({
      to: payload.to,
      eventTitle: submission.event.title,
      projectTitle: submission.title,
      teamName: submission.team?.name,
      eventPath: `/${encodeURIComponent(submission.event.organisation.slug)}/${encodeURIComponent(submission.event.slug)}`,
      recipientName: payload.recipientName,
      messageId,
    });
    return "sent";
  }
  if (kind === SUBMISSION_LINK_KIND) {
    const payload = asSubmissionLinkPayload(value);
    if (!payload) return null;
    const link = await prisma.submissionLink.findUnique({
      where: { rsvpId: payload.rsvpId },
      select: { tokenHash: true, rsvp: { select: { teamId: true, guestName: true, user: { select: { name: true } }, event: { select: { title: true } } } } },
    });
    // Regenerated, removed, or the registrant joined a team since: never send a link that no longer works.
    if (!link || link.tokenHash !== hashSubmissionLinkToken(payload.token) || !link.rsvp.event || link.rsvp.teamId) return "dropped";
    await sendSubmissionLinkEmail({
      to: payload.to,
      eventTitle: link.rsvp.event.title,
      submitPath: submissionLinkPath(payload.token),
      recipientName: link.rsvp.user?.name?.trim() || link.rsvp.guestName?.trim() || undefined,
      messageId,
    });
    return "sent";
  }
  const payload = asResultsPublishedPayload(value);
  if (!payload) return null;
  const event = await prisma.event.findUnique({
    where: { id: payload.eventId },
    select: { title: true, slug: true, resultsPublishedAt: true, organisation: { select: { slug: true } } },
  });
  if (!event?.resultsPublishedAt) return "dropped";
  await sendResultsPublishedEmail({ to: payload.to, eventTitle: event.title, resultsPath: resultsPath(event.organisation.slug, event.slug), recipientName: payload.recipientName, messageId });
  return "sent";
}
