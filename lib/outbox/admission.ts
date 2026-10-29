import "server-only";

/**
 * Application emails (docs/ADMISSION.md). One outbox kind, `admission-notice`,
 * per recipient registration. The payload carries ids only; the ticket link
 * (the applicant's way to answer) is read at send time, and a notice is
 * dropped when the application has moved on: a newer decision
 * (`decisionRevision`), or a status the notice no longer fits.
 *
 * Offers, reminders, expiries, extensions, waitlist places and declines
 * always go out (they carry a decision or a deadline). `stage-advanced` is
 * queued only when the organiser turned Event.emailApplicantsOnStageAdvance on.
 * Once the event is cancelled, notices that invite an answer or promise a
 * place later are dropped; expiries and declines still go out.
 */

import { AdmissionStatus, EventStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendAdmissionNoticeEmail, type AdmissionNoticeKind } from "@/lib/email/admission";
import { getBaseUrl } from "@/lib/email";
import { formatDayTime } from "@/lib/format/datetime";
import type { OutboxClient } from "./enqueue";
import { isBoundedString, isEmail } from "./payloads";

export const ADMISSION_NOTICE_KIND = "admission-notice";

const NOTICES: readonly AdmissionNoticeKind[] = ["offer", "reminder", "expired", "extended", "waitlisted", "rejected", "stage-advanced"];

/** The application status each notice needs at send time. */
const NEEDS: Record<AdmissionNoticeKind, AdmissionStatus> = {
  offer: AdmissionStatus.OFFERED,
  reminder: AdmissionStatus.OFFERED,
  extended: AdmissionStatus.OFFERED,
  expired: AdmissionStatus.EXPIRED,
  waitlisted: AdmissionStatus.WAITLISTED,
  rejected: AdmissionStatus.REJECTED,
  "stage-advanced": AdmissionStatus.IN_REVIEW,
};

/** Notices that are obsolete once the event is cancelled. */
const OBSOLETE_WHEN_CANCELLED: ReadonlySet<AdmissionNoticeKind> = new Set(["offer", "reminder", "extended", "waitlisted", "stage-advanced"]);

export type AdmissionNoticePayload = { to: string; organisationId: string; applicationId: string; rsvpId: string; notice: AdmissionNoticeKind; revision: number; recipientName?: string };

export async function enqueueAdmissionNotices(client: OutboxClient, payloads: AdmissionNoticePayload[]) {
  if (payloads.length === 0) return;
  await client.outboxMessage.createMany({ data: payloads.map((payload) => ({ kind: ADMISSION_NOTICE_KIND, payload: payload as Prisma.InputJsonValue })) });
}

export function asAdmissionNoticePayload(value: Prisma.JsonValue): AdmissionNoticePayload | null {
  const p = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!p || !isEmail(p.to) || !isBoundedString(p.organisationId, 64) || !isBoundedString(p.applicationId, 64) || !isBoundedString(p.rsvpId, 64)) return null;
  if (typeof p.notice !== "string" || !NOTICES.includes(p.notice as AdmissionNoticeKind)) return null;
  if (typeof p.revision !== "number" || !Number.isInteger(p.revision) || p.revision < 0) return null;
  if (p.recipientName !== undefined && !isBoundedString(p.recipientName, 200)) return null;
  return p as AdmissionNoticePayload;
}

export async function deliverAdmissionNotice(value: Prisma.JsonValue, messageId: string): Promise<"sent" | "dropped" | null> {
  const payload = asAdmissionNoticePayload(value);
  if (!payload) return null;
  const app = await prisma.admissionApplication.findUnique({
    where: { id: payload.applicationId },
    select: {
      status: true,
      rsvpId: true,
      teamId: true,
      decisionRevision: true,
      respondBy: true,
      currentStage: { select: { name: true } },
      team: { select: { name: true } },
      event: { select: { title: true, timezone: true, status: true } },
    },
  });
  const rsvp = await prisma.rSVP.findUnique({ where: { id: payload.rsvpId }, select: { id: true, teamId: true, checkInToken: true, order: { select: { totalMinor: true } } } });
  if (!app || !rsvp || app.status !== NEEDS[payload.notice] || app.decisionRevision !== payload.revision) return "dropped";
  if (app.event.status === EventStatus.CANCELLED && OBSOLETE_WHEN_CANCELLED.has(payload.notice)) return "dropped";
  // The recipient must still be this application's registration (or one of its team).
  if (app.rsvpId ? app.rsvpId !== rsvp.id : app.teamId !== rsvp.teamId) return "dropped";
  const order = app.teamId
    ? await prisma.order.findFirst({ where: { teamId: app.teamId, teamName: { not: null } }, select: { totalMinor: true } })
    : rsvp.order;
  await sendAdmissionNoticeEmail({
    to: payload.to,
    notice: payload.notice,
    eventTitle: app.event.title,
    applicationUrl: `${getBaseUrl()}/ticket/${encodeURIComponent(rsvp.checkInToken)}`,
    respondBy: app.respondBy ? formatDayTime(app.respondBy, app.event.timezone) : undefined,
    stageName: app.currentStage?.name,
    paid: Boolean(order && order.totalMinor > BigInt(0)),
    teamName: app.team?.name,
    recipientName: payload.recipientName,
    messageId,
  });
  return "sent";
}
