import { Prisma, RsvpStatus } from "@prisma/client";
import { CHECKOUT_WINDOWS } from "./providers/types";

/** How long seats stay held while a buyer pays at checkout. */
export const CHECKOUT_HOLD_MS = 30 * 60_000;
/** Approved, promoted or hand-added guests get a day to pay from the emailed link. */
export const PAYMENT_LINK_HOLD_MS = 24 * 60 * 60_000;
/**
 * How far a hold may stretch so a provider page can still open: a checkout
 * hold never exceeds 60 minutes in total.
 */
export const HOLD_EXTENSION_CAP_MS = 30 * 60_000;
/** Margin added to a provider's minimum page lifetime. */
const ATTEMPT_MARGIN_MS = 2 * 60_000;

/**
 * Spread into every RSVP count compared with a capacity: crew tickets
 * (docs/CREW.md) count in headcounts but never take an attendee place.
 */
export const takesCapacity = { isCrew: false } as const satisfies Prisma.RSVPWhereInput;

/**
 * Registrations that occupy a seat: confirmed ones and paid tickets whose
 * hold has not ended, never crew tickets. Every capacity count uses this,
 * under the same event row lock, so a held seat can never be sold twice.
 */
export function seatTakingWhere(now: Date): Prisma.RSVPWhereInput {
  return {
    ...takesCapacity,
    OR: [
      { status: RsvpStatus.CONFIRMED },
      { status: RsvpStatus.PENDING_PAYMENT, holdExpiresAt: { gt: now } },
    ],
  };
}

export function isActiveHold(rsvp: { status: RsvpStatus; holdExpiresAt: Date | null; }, now = new Date()) {
  return rsvp.status === RsvpStatus.PENDING_PAYMENT && rsvp.holdExpiresAt != null && rsvp.holdExpiresAt > now;
}

/**
 * When a new checkout page for an order may expire, and the hold it needs.
 * The page must live at least the provider's minimum (plus a margin), and
 * the hold is extended to match, but never beyond the hold's cap. A long
 * (24-hour) hold keeps its end, within the provider's maximum page lifetime.
 * Null when the hold is too close to its cap for a page to open.
 */
export function nextAttemptWindow(provider: keyof typeof CHECKOUT_WINDOWS, hold: { expiresAt: Date; capAt: Date; }, now = new Date()) {
  const window = CHECKOUT_WINDOWS[provider];
  const needed = now.getTime() + window.minMs + ATTEMPT_MARGIN_MS;
  const holdEnd = Math.max(hold.expiresAt.getTime(), needed);
  if (holdEnd > hold.capAt.getTime()) return null;
  const pageEnd = Math.min(holdEnd, now.getTime() + window.maxMs);
  if (pageEnd < needed) return null;
  return { holdExpiresAt: new Date(holdEnd), attemptExpiresAt: new Date(pageEnd) };
}
