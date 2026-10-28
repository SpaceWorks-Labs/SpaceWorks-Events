import "server-only";

import { EventPrivacyType, type EventStatus, RsvpStatus } from "@prisma/client";
import { isEventPublished } from "@/lib/eventVisibility";
import type { ChipTone } from "@/components/ui/display";

/* ---------- Pure helpers (unit-tested) ---------- */

export type RegistrationStatusView = { label: string; tone: ChipTone };

/** The single attendee-facing status for one RSVP. A check-in outranks the RSVP status. */
export function registrationStatus(status: RsvpStatus, checkedInAt: Date | null): RegistrationStatusView {
  if (checkedInAt) return { label: "Checked in", tone: "success" };
  switch (status) {
    case RsvpStatus.CONFIRMED:
      return { label: "Confirmed", tone: "success" };
    case RsvpStatus.WAITLISTED:
      return { label: "Waitlisted", tone: "warning" };
    case RsvpStatus.PENDING_APPROVAL:
      return { label: "Waiting for approval", tone: "warning" };
    case RsvpStatus.REJECTED:
      return { label: "Declined", tone: "danger" };
    case RsvpStatus.PENDING_PAYMENT:
      return { label: "Payment pending", tone: "warning" };
    default:
      return { label: "Registered", tone: "neutral" };
  }
}

/** Upcoming until the occurrence has ended; ongoing events stay upcoming. */
export function isUpcoming(endDateTime: Date, now: Date): boolean {
  return endDateTime.getTime() >= now.getTime();
}

/** Attendees may withdraw until check-in, while the occurrence has not ended and was not declined. */
export function canCancelRegistration(row: { status: RsvpStatus; checkedInAt: Date | null; end: Date }, now: Date): boolean {
  return !row.checkedInAt && row.status !== RsvpStatus.REJECTED && isUpcoming(row.end, now);
}

/**
 * Mirrors `resolvePublicEventAccess` for an ordinary attendee (no organiser
 * preview): published, website released, and for invite-only an invitation
 * matching the user's verified email.
 */
export function isEventPageReachable(input: {
  status: EventStatus;
  privacyType: EventPrivacyType;
  websiteReleased: boolean;
  invited: boolean;
}): boolean {
  if (!isEventPublished(input.status) || !input.websiteReleased) return false;
  return input.privacyType !== EventPrivacyType.INVITE_ONLY || input.invited;
}
