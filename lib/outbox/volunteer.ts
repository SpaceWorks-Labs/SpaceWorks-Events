import "server-only";

/**
 * Volunteer shift and certificate notices (docs/VOLUNTEERS.md): shift
 * approved, promoted from the waitlist, cancelled by the organisers, and
 * certificate issued. Transactional, one per person and change, never bulk.
 */

import { Prisma, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendVolunteerNoticeEmail, type VolunteerNoticeKind } from "@/lib/email/volunteer";
import type { OutboxClient } from "./enqueue";
import { isBoundedString, isEmail } from "./payloads";

export const VOLUNTEER_NOTICE_KIND = "volunteer-notice";
const NOTICES: readonly VolunteerNoticeKind[] = ["approved", "promoted", "cancelled", "certificate"];

/**
 * Ids only, plus for a cancellation the shift as it was (the sign-up or the
 * whole shift may be gone by send time). Names, the ticket link and whether
 * the place still stands are read at send time; the message is deleted after
 * delivery because it carries the crew ticket link.
 */
export type VolunteerNoticePayload = {
  to: string;
  organisationId: string;
  notice: VolunteerNoticeKind;
  crewMemberId: string;
  signupId?: string;
  shift?: { title: string; zone: string; startsAt: string; endsAt: string };
};

export async function enqueueVolunteerNotice(client: OutboxClient, payload: VolunteerNoticePayload) {
  return client.outboxMessage.create({ data: { kind: VOLUNTEER_NOTICE_KIND, payload: payload as Prisma.InputJsonValue } });
}

export function asVolunteerNoticePayload(value: Prisma.JsonValue): VolunteerNoticePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (!isEmail(p.to) || !isBoundedString(p.organisationId, 64) || !isBoundedString(p.crewMemberId, 64) || !NOTICES.includes(p.notice as VolunteerNoticeKind)) return null;
  if (p.signupId !== undefined && !isBoundedString(p.signupId, 64)) return null;
  if (p.shift !== undefined) {
    const s = p.shift as Record<string, unknown> | null;
    if (!s || !isBoundedString(s.title, 120) || typeof s.zone !== "string" || s.zone.length > 100 || !isBoundedString(s.startsAt, 40) || !isBoundedString(s.endsAt, 40)) return null;
  }
  return p as VolunteerNoticePayload;
}

/** "dropped" when the place, crew ticket, certificate or event no longer stands; null for an invalid payload. */
export async function deliverVolunteerNotice(value: Prisma.JsonValue, messageId: string): Promise<"sent" | "dropped" | null> {
  const payload = asVolunteerNoticePayload(value);
  if (!payload) return null;
  const member = await prisma.eventCrewMember.findUnique({
    where: { id: payload.crewMemberId },
    select: { name: true, rsvp: { select: { status: true, checkInToken: true } }, event: { select: { organisationId: true, title: true, status: true, timezone: true } } },
  });
  if (!member || member.rsvp.status !== RsvpStatus.CONFIRMED || member.event.organisationId !== payload.organisationId || member.event.status === "CANCELLED") return "dropped";
  let shift: { title: string; zone: string; startsAt: Date; endsAt: Date } | undefined;
  if (payload.notice === "approved" || payload.notice === "promoted") {
    const signup = payload.signupId
      ? await prisma.volunteerShiftSignup.findFirst({ where: { id: payload.signupId, crewMemberId: payload.crewMemberId }, select: { status: true, shift: { select: { title: true, zone: true, startsAt: true, endsAt: true } } } })
      : null;
    if (signup?.status !== "APPROVED") return "dropped";
    shift = signup.shift;
  } else if (payload.notice === "cancelled") {
    if (!payload.shift) return null;
    shift = { ...payload.shift, startsAt: new Date(payload.shift.startsAt), endsAt: new Date(payload.shift.endsAt) };
  } else if (!(await prisma.contributorCertificate.count({ where: { crewMemberId: payload.crewMemberId, revokedAt: null } }))) {
    return "dropped";
  }
  await sendVolunteerNoticeEmail({
    to: payload.to,
    notice: payload.notice,
    eventTitle: member.event.title,
    checkInToken: member.rsvp.checkInToken,
    recipientName: member.name,
    timezone: member.event.timezone,
    shift,
    messageId,
  });
  return "sent";
}
