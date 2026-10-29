import { prisma } from "@/lib/db";
import type { OrderAttendee } from "@/lib/payments/orders";

export function normalizeGuestEmail(email: string) {
  return email.trim().toLowerCase();
}

export class RsvpTargetClosedError extends Error {}

export function isRsvpTargetClosedError(error: unknown): error is RsvpTargetClosedError {
  return error instanceof RsvpTargetClosedError;
}

/**
 * Invite-only public registration (docs/SECURITY.md): one place, for the
 * signed-in invitee. Re-checked under the reservation's lock, so an audience
 * switched to invite-only (or an invitation withdrawn) while a registration
 * waits on that lock is refused.
 */
export class RsvpInviteRequiredError extends Error {
  constructor(signedIn: boolean) {
    super(signedIn
      ? "This event is invite-only. Use the email you were invited with."
      : "This event is invite-only. Sign in with the invited account to register.");
  }
}

export type AnswerRow = { fieldId: string; valueText?: string | null; valueBool?: boolean | null; valueNumber?: number | null; valueDate?: Date | null; };

export type OrderRequest = {
  items?: Array<{ ticketTypeId: string; quantity: number; amountMinor?: number | null; }>;
  ticketTypeId?: string;
  attendees?: OrderAttendee[];
  promoCode?: string;
  accessCode?: string;
  addOns?: Array<{ addOnId: string; quantity: number; }>;
  payAtDesk?: boolean;
};

export function requestedItems(request: OrderRequest) {
  if (request.items?.length) return request.items;
  return request.ticketTypeId ? [{ ticketTypeId: request.ticketTypeId, quantity: 1 }] : [];
}

export async function resolveAttendeeEmail(
  userId: string | null,
  guestEmail: string | undefined,
): Promise<{ email: string } | { error: string }> {
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user?.email?.trim()) {
      return {
        error:
          "Your account needs an email address to RSVP to this event. Update your profile or use the guest form.",
      };
    }
    return { email: normalizeGuestEmail(user.email) };
  }
  if (guestEmail) {
    return { email: normalizeGuestEmail(guestEmail) };
  }
  return { error: "Email is required." };
}
