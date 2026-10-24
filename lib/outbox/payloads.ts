import "server-only";

/** The outbox's message shapes, and the checks every queued payload passes before it is sent. */

import { Prisma, RsvpStatus } from "@prisma/client";
import { isBroadcastDesign } from "@/lib/email/broadcastDesigns";

export type RsvpConfirmationPayload = {
  to: string;
  eventTitle: string;
  status: RsvpStatus;
  checkInToken: string;
  /** Set for registrations on a TEAM event that belong to a team. */
  teamName?: string;
};

export type RsvpStatusPayload = {
  to: string;
  /** Sent as this organisation when there is no ticket to work it out from (a decline). */
  organisationId?: string;
  eventTitle: string;
  approved: boolean;
  checkInToken?: string;
  recipientName?: string;
  /** Team status changes email each member, naming the team. */
  teamName?: string;
};

export type PasswordResetPayload = {
  to: string;
  resetUrl: string;
  expiresAt: string;
};

export type EventInvitePayload = {
  to: string;
  eventTitle: string;
  organisationName: string;
  orgSlug: string;
  eventSlug: string;
  /** A series invite links its next date, "/<org>/i/<date id>", instead of an event page. */
  eventPath?: string;
  expiresAt?: string;
};

/** A site path an invite may link: an event page or a series date page. */
export const INVITE_PATH = /^\/[a-z0-9-]{1,64}(\/i\/[a-z0-9]{10,40})?$/;

export type EmailVerificationPayload = {
  to: string;
  verificationUrl: string;
  expiresAt: string;
};

export type CollaboratorInvitePayload = { to: string; eventTitle: string; inviteUrl: string; expiresAt?: string; organisationId?: string };

/** Per-recipient broadcast row. The template and ticket link are resolved at send time, so the queue never stores capabilities. */
export type EventBroadcastPayload = { to: string; broadcastId: string; rsvpId: string };

export type EventBroadcastTestPayload = { to: string; eventId: string; subject: string; body: string; design?: string; recipientName?: string };

/** A guest's reminder before the event. The ticket link is built at send time, so the queue never stores it. */
export type EventReminderPayload = { to: string; rsvpId: string };

export const EVENT_REMINDER_KIND = "event-reminder";

export function asEventReminderPayload(value: Prisma.JsonValue): EventReminderPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  return isEmail(p.to) && isBoundedString(p.rsvpId, 64) ? p as EventReminderPayload : null;
}

/** A short plain message to a super admin: the test email and backup alerts. It never carries links or secrets. */
export type OperatorNoticePayload = { to: string; subject: string; lines: string[]; /** Sent as this organisation; none for platform notices. */ organisationId?: string };

/** A one-time sign-in code: a capability, removed once delivered and never retried past its expiry. */
export type SignInCodePayload = { to: string; code: string; expiresAt: string };

export function asSignInCodePayload(value: Prisma.JsonValue): SignInCodePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  return isEmail(p.to) && typeof p.code === "string" && /^\d{6}$/.test(p.code) && isIsoDate(p.expiresAt) ? p as SignInCodePayload : null;
}

export function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function isEmail(value: unknown): value is string {
  return isBoundedString(value, 320) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isIsoDate(value: unknown): value is string {
  return isBoundedString(value, 64) && !Number.isNaN(Date.parse(value));
}

export function isSafeMessageUrl(value: unknown): value is string {
  if (!isBoundedString(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (process.env.NODE_ENV !== "production" && url.protocol === "http:");
  } catch {
    return false;
  }
}

export function isExpired(expiresAt: string | undefined, now = new Date()) {
  return expiresAt !== undefined && new Date(expiresAt) <= now;
}

export function containsCapability(kind: string, payload: Prisma.JsonValue) {
  if (["rsvp-confirmation", "password-reset", "email-verification", "collaborator-invite", "sign-in-code", "team-created", "team-member-added"].includes(kind)) return true;
  return kind === "rsvp-status" && Boolean(payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as Record<string, unknown>).checkInToken === "string");
}

export function messageId(id: string) {
  return `<swe-${id}@outbox.invalid>`;
}

export function retryDelayMs(kind: string, attempts: number) {
  const exponentialDelay = 2 ** attempts * 60_000;
  // Verification and reset capabilities expire after one hour. Retrying them
  // on the normal 32/60-minute cadence can leave most of the configured
  // attempts unusable, so keep their retries within the capability lifetime.
  const maximumDelay = kind === "password-reset" || kind === "email-verification" || kind === "sign-in-code"
    ? 8 * 60_000
    : 60 * 60_000;
  return Math.min(maximumDelay, exponentialDelay);
}

export class PermanentOutboxError extends Error {
  override name = "PermanentOutboxError";
}

export function asRsvpConfirmationPayload(value: Prisma.JsonValue): RsvpConfirmationPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    !isEmail(payload.to) ||
    !isBoundedString(payload.eventTitle, 200) ||
    !isBoundedString(payload.checkInToken, 128) ||
    !Object.values(RsvpStatus).includes(payload.status as RsvpStatus) ||
    (payload.teamName !== undefined && !isBoundedString(payload.teamName, 200))
  ) {
    return null;
  }
  return payload as RsvpConfirmationPayload;
}

export function asRsvpStatusPayload(value: Prisma.JsonValue): RsvpStatusPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    !isEmail(payload.to) ||
    !isBoundedString(payload.eventTitle, 200) ||
    typeof payload.approved !== "boolean" ||
    (payload.approved && !isBoundedString(payload.checkInToken, 128)) ||
    (payload.checkInToken !== undefined && !isBoundedString(payload.checkInToken, 128)) ||
    (payload.recipientName !== undefined && !isBoundedString(payload.recipientName, 200)) ||
    (payload.teamName !== undefined && !isBoundedString(payload.teamName, 200))
  ) return null;
  return payload as RsvpStatusPayload;
}

export function asPasswordResetPayload(value: Prisma.JsonValue): PasswordResetPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    !isEmail(payload.to) ||
    !isSafeMessageUrl(payload.resetUrl) ||
    !isIsoDate(payload.expiresAt)
  ) return null;
  return payload as PasswordResetPayload;
}

export function asEventInvitePayload(value: Prisma.JsonValue): EventInvitePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    !isEmail(payload.to) ||
    !isBoundedString(payload.eventTitle, 200) ||
    !isBoundedString(payload.organisationName, 120) ||
    !isBoundedString(payload.orgSlug, 64) ||
    !isBoundedString(payload.eventSlug, 64) ||
    (payload.eventPath !== undefined && !(typeof payload.eventPath === "string" && INVITE_PATH.test(payload.eventPath))) ||
    (payload.expiresAt !== undefined && !isIsoDate(payload.expiresAt))
  ) return null;
  return payload as EventInvitePayload;
}

export function asEmailVerificationPayload(value: Prisma.JsonValue): EmailVerificationPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (!isEmail(payload.to) || !isSafeMessageUrl(payload.verificationUrl) || !isIsoDate(payload.expiresAt)) return null;
  return payload as EmailVerificationPayload;
}

export function asEventBroadcastPayload(value: Prisma.JsonValue): EventBroadcastPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (!isEmail(payload.to) || !isBoundedString(payload.broadcastId, 64) || !isBoundedString(payload.rsvpId, 64)) return null;
  return payload as EventBroadcastPayload;
}

export function asEventBroadcastTestPayload(value: Prisma.JsonValue): EventBroadcastTestPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    !isEmail(payload.to) ||
    !isBoundedString(payload.eventId, 64) ||
    !isBoundedString(payload.subject, 150) ||
    !isBoundedString(payload.body, 20000) ||
    (payload.recipientName !== undefined && !isBoundedString(payload.recipientName, 200)) ||
    (payload.design !== undefined && !isBroadcastDesign(payload.design))
  ) return null;
  return payload as EventBroadcastTestPayload;
}

export function asCollaboratorInvitePayload(value: Prisma.JsonValue): CollaboratorInvitePayload | null { if (!value || typeof value !== "object" || Array.isArray(value)) return null; const p = value as Record<string, unknown>; return isEmail(p.to) && isBoundedString(p.eventTitle, 200) && isSafeMessageUrl(p.inviteUrl) && (p.expiresAt === undefined || isIsoDate(p.expiresAt)) ? p as CollaboratorInvitePayload : null; }

export function asOperatorNoticePayload(value: Prisma.JsonValue): OperatorNoticePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  return isEmail(p.to) && isBoundedString(p.subject, 200) && Array.isArray(p.lines) && p.lines.length <= 10 && p.lines.every((line) => isBoundedString(line, 1000))
    ? p as OperatorNoticePayload
    : null;
}
