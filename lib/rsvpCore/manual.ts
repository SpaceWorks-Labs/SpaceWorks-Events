import { OfflinePaymentMethod, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { manualRsvpSchema } from "@/lib/validators";
import type { ActionResult } from "@/app/actions/org";
import { flattenZodErrors } from "@/app/actions/utils";
import { isPaidEventsEnabled } from "@/lib/instanceSettings";
import { recordAuditEvent } from "@/lib/audit";
import { OrderError, reserveOrder } from "@/lib/payments/orders";
import { validateAndNormalizeAnswers } from "./answers";
import { paymentContextFor, sellsTickets } from "./orders";
import { reserveRsvp } from "./reserve";
import { publicCountField } from "@/lib/publicRegistrationCount";
import { TeamRegistrationError, teamRegistrationFailure } from "./team";
import { normalizeGuestEmail } from "./shared";

/**
 * Creates a guest RSVP on behalf of an authorised event administrator. Unlike
 * the public flow, this can register someone for a draft, ended, or invite-only
 * event; capacity, waitlist, approval, duplicate, form-answer, and ticket
 * rules remain owned by the same RSVP service.
 */
export async function submitManualGuestRsvpCore(
  input: unknown,
  opts: { organisationId: string },
): Promise<ActionResult<{ count?: number; status: RsvpStatus; rsvpId: string }>> {
  const parsed = manualRsvpSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const event = await prisma.event.findFirst({
    where: { id: parsed.data.eventId, organisationId: opts.organisationId },
  });
  if (!event) return { ok: false, error: "Event not found." };

  // Events that sell tickets add guests with a ticket (addTicketGuest).
  if (await sellsTickets({ eventId: event.id })) return { ok: false, error: "Choose a ticket for this guest." };

  const email = normalizeGuestEmail(parsed.data.guestEmail);
  const form = await prisma.eventRegistrationForm.findUnique({
    where: { eventId: event.id },
    include: { fields: { orderBy: { sortOrder: "asc" } } },
  });
  const validated = validateAndNormalizeAnswers({
    fields: (form?.fields ?? []).map((field) => ({
      id: field.id,
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      options: field.options,
      settings: field.settings,
    })),
    answers: parsed.data.answers as Record<string, unknown>,
  });
  if ("error" in validated) return { ok: false, error: validated.error };

  try {
    const reservation = await reserveRsvp({
      target: { eventId: event.id },
      capacity: event.capacity,
      privacyType: event.privacyType,
      notification: { to: email, eventTitle: event.title },
      data: {
        eventId: event.id,
        userId: null,
        guestEmail: email,
        guestName: parsed.data.name.trim(),
        attendeeKey: `guest:${email}`,
      },
      enforceOpen: false,
      // Organisers may add a solo registrant even to a TEAMS_ONLY event.
      allowSoloWithoutTeam: true,
      afterCreate: async (tx, rsvpId) => {
        if (validated.rows.length === 0) return;
        await tx.rsvpAnswer.createMany({
          data: validated.rows.map((row) => ({
            rsvpId,
            fieldId: row.fieldId,
            valueText: row.valueText ?? null,
            valueBool: row.valueBool ?? null,
            valueNumber: row.valueNumber ?? null,
            valueDate: row.valueDate ?? null,
          })),
        });
      },
    });
    return {
      ok: true,
      data: {
        ...publicCountField(reservation.count),
        status: reservation.status,
        rsvpId: reservation.id,
      },
    };
  } catch (error: unknown) {
    if (error instanceof TeamRegistrationError) return teamRegistrationFailure(error);
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return { ok: false, error: "This email is already registered for this event." };
    }
    console.error("[rsvp] manual submission failed");
    return { ok: false, error: "Could not save the attendee RSVP." };
  }
}

/**
 * An organiser adds a guest with a ticket. A paid ticket is settled one of
 * three ways: a payment link emailed with a day to pay, money collected in
 * person, or complimentary. Without an online account the last two still
 * work, recorded as offline payments.
 */
export async function submitManualTicketOrderCore(
  input: {
    eventId: string; name: string; guestEmail: string; ticketTypeId: string;
    payment: "link" | "offline" | "waive"; method?: OfflinePaymentMethod; reference?: string | null;
    answers: Record<string, unknown>;
  },
  opts: { organisationId: string; actorUserId: string; },
): Promise<ActionResult<{ status: RsvpStatus; orderId: string; }>> {
  const event = await prisma.event.findFirst({ where: { id: input.eventId, organisationId: opts.organisationId }, select: { id: true, organisationId: true } });
  if (!event) return { ok: false, error: "Event not found." };
  const email = normalizeGuestEmail(input.guestEmail);
  const form = await prisma.eventRegistrationForm.findUnique({ where: { eventId: event.id }, include: { fields: { orderBy: { sortOrder: "asc" } } } });
  const validated = validateAndNormalizeAnswers({
    fields: (form?.fields ?? []).map((field) => ({ id: field.id, key: field.key, label: field.label, type: field.type, required: field.required, options: field.options, settings: field.settings })),
    answers: input.answers,
  });
  if ("error" in validated) return { ok: false, error: validated.error };
  const items = [{ ticketTypeId: input.ticketTypeId, quantity: 1 }];
  let payment = await paymentContextFor(event.organisationId, items);
  if (!payment && input.payment !== "link" && await isPaidEventsEnabled()) {
    payment = { organisationId: event.organisationId, provider: "OFFLINE", testMode: false };
  }
  try {
    const order = await prisma.$transaction(async (tx) => {
      const reserved = await reserveOrder(tx, {
        target: { eventId: event.id },
        items,
        buyer: { userId: null, email, name: input.name.trim(), attendeeKey: `guest:${email}` },
        attendees: [],
        enforceOpen: false,
        payment,
        manual: { mode: input.payment, method: input.method, reference: input.reference, actorUserId: opts.actorUserId },
      });
      if (validated.rows.length > 0) {
        await tx.rsvpAnswer.createMany({
          data: validated.rows.map((row) => ({ rsvpId: reserved.buyerRsvpId, fieldId: row.fieldId, valueText: row.valueText ?? null, valueBool: row.valueBool ?? null, valueNumber: row.valueNumber ?? null, valueDate: row.valueDate ?? null })),
        });
      }
      await recordAuditEvent({ action: "MANUAL_RSVP_CREATED", actorUserId: opts.actorUserId, organisationId: event.organisationId, targetType: "RSVP", targetId: reserved.buyerRsvpId, metadata: { eventId: event.id, status: reserved.status, payment: input.payment }, client: tx });
      return reserved;
    });
    return { ok: true, data: { status: order.status, orderId: order.orderId } };
  } catch (error: unknown) {
    if (error instanceof OrderError) return { ok: false, error: error.message };
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002") {
      return { ok: false, error: "This email is already registered for this event." };
    }
    console.error("[rsvp] manual ticket order failed");
    return { ok: false, error: "Could not add the guest." };
  }
}
