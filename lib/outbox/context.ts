import "server-only";

/** What a message is about: its registration, broadcast event, and the organisation it is sent as. */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { formatBroadcastEventDate } from "@/lib/broadcastTemplate";
import { broadcastBrandSelect, broadcastEventUrl, broadcastFeedbackUrl, broadcastScheduleUrl } from "@/lib/eventBroadcast";
import { MEMBER_ID_EMAIL_KIND } from "@/lib/memberIds/email";
import { PAYMENT_EMAIL_KIND } from "@/lib/payments/email";
import { isTeamMessageKind, teamMessageOrganisation } from "./team";
import { isJudgingMessageKind, judgingMessageOrganisation } from "./judging";
import { EVENT_REMINDER_KIND } from "./payloads";
import { ATTENDANCE_CHECK_KIND, attendanceMessageOrganisation } from "./attendance";

export async function getCurrentRsvp(checkInToken: string) {
  return prisma.rSVP.findUnique({
    where: { checkInToken },
    select: {
      status: true,
      guestName: true,
      user: { select: { name: true } },
      event: { select: { startDateTime: true, endDateTime: true, timezone: true, location: true } },
      eventInstance: { select: { startDateTime: true, endDateTime: true, series: { select: { timezone: true } } } },
    },
  });
}

export function calendarEvent(rsvp: Awaited<ReturnType<typeof getCurrentRsvp>>) {
  if (rsvp?.event) {
    return rsvp.event;
  }
  if (rsvp?.eventInstance) {
    return {
      startDateTime: rsvp.eventInstance.startDateTime,
      endDateTime: rsvp.eventInstance.endDateTime,
      timezone: rsvp.eventInstance.series.timezone,
    };
  }
  return undefined;
}

export function attendeeName(rsvp: Awaited<ReturnType<typeof getCurrentRsvp>>) {
  return rsvp?.user?.name?.trim() || rsvp?.guestName?.trim() || undefined;
}

export const broadcastEventSelect = {
  title: true,
  slug: true,
  startDateTime: true,
  timezone: true,
  location: true,
  isOnline: true,
  ...broadcastBrandSelect,
  organisation: { select: { name: true, slug: true, logoUrl: true } },
} as const;

export type BroadcastEvent = {
  title: string;
  slug: string;
  startDateTime: Date;
  timezone: string;
  location: string;
  isOnline: boolean;
  organisation: { name: string; slug: string; logoUrl: string | null };
};

export function broadcastVariablesFor(event: BroadcastEvent, recipient: { name?: string | null; ticketUrl?: string | null }) {
  const eventUrl = broadcastEventUrl(event.organisation.slug, event.slug);
  return {
    name: recipient.name,
    event: event.title,
    eventDate: formatBroadcastEventDate(event.startDateTime, event.timezone),
    location: event.isOnline ? "Online" : (event.location.trim() || "the venue"),
    eventUrl,
    ticketLink: recipient.ticketUrl ?? eventUrl,
    feedbackUrl: broadcastFeedbackUrl(event.organisation.slug, event.slug),
    scheduleUrl: broadcastScheduleUrl(event.organisation.slug, event.slug),
    organisation: event.organisation.name,
  };
}

/** Account and security email always comes from the platform. */
export const PLATFORM_KINDS = new Set(["password-reset", "email-verification"]);

/**
 * Whose email a message is, so it goes out through that organisation's
 * server or under its name. Messages that don't say are worked out from the
 * registration, event, broadcast, payment or member they are about.
 */
export async function messageOrganisation(kind: string, payload: Prisma.JsonValue): Promise<string | null> {
  if (PLATFORM_KINDS.has(kind) || !payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const text = (key: string) => (typeof p[key] === "string" && (p[key] as string).length <= 200 ? p[key] as string : null);
  if (text("organisationId")) return text("organisationId");
  const rsvpOwner = { event: { select: { organisationId: true } }, eventInstance: { select: { series: { select: { organisationId: true } } } } } as const;
  const ofRsvp = (rsvp: { event: { organisationId: string; } | null; eventInstance: { series: { organisationId: string; }; } | null; } | null) => rsvp?.event?.organisationId ?? rsvp?.eventInstance?.series.organisationId ?? null;
  if ((kind === "rsvp-confirmation" || kind === "rsvp-status") && text("checkInToken")) {
    return ofRsvp(await prisma.rSVP.findUnique({ where: { checkInToken: text("checkInToken")! }, select: rsvpOwner }));
  }
  if (kind === EVENT_REMINDER_KIND && text("rsvpId")) return ofRsvp(await prisma.rSVP.findUnique({ where: { id: text("rsvpId")! }, select: rsvpOwner }));
  if (kind === "event-invite" && text("orgSlug")) return (await prisma.organisation.findUnique({ where: { slug: text("orgSlug")! }, select: { id: true } }))?.id ?? null;
  if (kind === "event-broadcast" && text("broadcastId")) return (await prisma.eventBroadcast.findUnique({ where: { id: text("broadcastId")! }, select: { event: { select: { organisationId: true } } } }))?.event.organisationId ?? null;
  if (kind === "event-broadcast-test" && text("eventId")) return (await prisma.event.findUnique({ where: { id: text("eventId")! }, select: { organisationId: true } }))?.organisationId ?? null;
  if (kind === PAYMENT_EMAIL_KIND && text("paymentId")) return (await prisma.payment.findUnique({ where: { id: text("paymentId")! }, select: { organisationId: true } }))?.organisationId ?? null;
  if (kind === PAYMENT_EMAIL_KIND && text("orderId")) return (await prisma.order.findUnique({ where: { id: text("orderId")! }, select: { organisationId: true } }))?.organisationId ?? null;
  if (isTeamMessageKind(kind)) return teamMessageOrganisation(kind, p);
  if (isJudgingMessageKind(kind)) return judgingMessageOrganisation(kind, p);
  if (kind === ATTENDANCE_CHECK_KIND) return attendanceMessageOrganisation(p);
  if (kind === MEMBER_ID_EMAIL_KIND && text("memberId")) return (await prisma.idMember.findUnique({ where: { id: text("memberId")! }, select: { programme: { select: { organisationId: true } } } }))?.programme.organisationId ?? null;
  return null;
}
