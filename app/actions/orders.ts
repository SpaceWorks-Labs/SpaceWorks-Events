"use server";

import { CREW_EMAIL_REFUSED, hasCrewEmail } from "@/lib/core/crew/shared";
import { z } from "zod";
import { revalidatePath as nextRevalidatePath } from "next/cache";
import type { ActionResult } from "@/app/actions/org";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { recordAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { enqueueRsvpConfirmation } from "@/lib/outbox";
import { AdmissionManagedError, cancelOrderAsBuyer, PaymentOperationError } from "@/lib/payments/operations";
import { validateAndNormalizeAnswers } from "@/lib/rsvpCore";
import { isValidAttendeeName } from "@/lib/validators";
import { lockOrderTargets, ORDER_SUBJECT_SELECT, orderSubject } from "@/lib/payments/targets";
import { replaceRegistrationAnswers } from "@/lib/admission/answers";
import { AdmissionError } from "@/lib/admission/state";
import { OpenClaimsError, transferTicket } from "@/lib/payments/transfers";

const revalidatePath = trackedRevalidation(nextRevalidatePath);

const attendeeSchema = z.object({
  orderToken: z.string().trim().regex(/^[a-z0-9]{20,40}$/),
  rsvpId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1, "Enter the attendee's name.").max(200),
  email: z.string().trim().toLowerCase().email("Enter a valid email.").max(320).optional().or(z.literal("")),
  answers: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

/**
 * The buyer fills in who holds each ticket of their order. The order's
 * access token is the proof, like a ticket link. An attendee's email can be
 * added while the ticket has none; changing it later is a transfer, which
 * the organiser handles.
 */
export async function updateOrderAttendee(input: unknown): Promise<ActionResult> {
  const parsed = attendeeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the attendee details." };
  if (await isActionRateLimited("rsvp", parsed.data.orderToken)) return { ok: false, error: "Too many changes. Try again shortly." };
  if (!isValidAttendeeName(parsed.data.name)) return { ok: false, error: "Enter a valid name." };
  const order = await prisma.order.findUnique({
    where: { accessToken: parsed.data.orderToken },
    select: { id: true, organisationId: true, status: true, eventId: true, eventSeriesId: true, ...ORDER_SUBJECT_SELECT },
  });
  if (!order) return { ok: false, error: "Order not found." };
  const form = order.eventId ? await prisma.eventRegistrationForm.findUnique({ where: { eventId: order.eventId }, include: { fields: { orderBy: { sortOrder: "asc" } } } }) : null;
  const validated = validateAndNormalizeAnswers({
    fields: (form?.fields ?? []).map((field) => ({ id: field.id, key: field.key, label: field.label, type: field.type, required: field.required, options: field.options, settings: field.settings })),
    answers: parsed.data.answers as Record<string, unknown>,
  });
  if ("error" in validated) return { ok: false, error: validated.error };

  const email = parsed.data.email || null;
  try {
    const refused = await prisma.$transaction(async (tx) => {
      // The event or dates, then the order's tickets by id (docs/PAYMENTS.md lock order); read under the lock.
      await lockOrderTargets(tx, order);
      await tx.$queryRaw`SELECT "id" FROM "RSVP" WHERE "orderId" = ${order.id} ORDER BY "id" FOR UPDATE`;
      const rsvp = await tx.rSVP.findFirst({
        where: { id: parsed.data.rsvpId, orderId: order.id },
        select: { id: true, eventId: true, teamId: true, userId: true, guestEmail: true, checkedInAt: true, checkInToken: true, status: true, attendeeKey: true },
      });
      if (!rsvp) return "Ticket not found.";
      if (rsvp.checkedInAt) return "This ticket has already been used to check in.";
      if (rsvp.userId && email) return "This ticket belongs to a signed-in account; its email can't change here.";
      if (rsvp.guestEmail && email && email !== rsvp.guestEmail) return "To give this ticket to someone else, ask the organiser to transfer it.";
      const newEmail = !rsvp.userId && !rsvp.guestEmail && email ? email : null;
      // A crew member already holds a free crew ticket (docs/CREW.md); checked under the Event lock.
      if (newEmail && order.eventId && (await hasCrewEmail(tx, order.eventId, [newEmail]))) return CREW_EMAIL_REFUSED;
      // The same person on every date of a pass.
      if (!rsvp.userId) {
        await tx.rSVP.updateMany({
          where: { orderId: order.id, attendeeKey: rsvp.attendeeKey, checkedInAt: null },
          data: { guestName: parsed.data.name, ...(newEmail ? { guestEmail: newEmail, attendeeKey: `guest:${newEmail}` } : {}) },
        });
      }
      // Applications keep their answer rules and revisions (lib/admission/answers.ts).
      await replaceRegistrationAnswers(tx, { id: rsvp.id, eventId: rsvp.eventId, teamId: rsvp.teamId, attendeeKey: newEmail ? `guest:${newEmail}` : rsvp.attendeeKey }, validated.rows);
      // A confirmed ticket that just got its holder's address is sent to them.
      if (newEmail && rsvp.status === "CONFIRMED") {
        await enqueueRsvpConfirmation(tx, { to: newEmail, eventTitle: orderSubject(order)?.title ?? "Your event", status: "CONFIRMED", checkInToken: rsvp.checkInToken });
      }
      await recordAuditEvent({ action: "ORDER_ATTENDEE_UPDATED", organisationId: order.organisationId, targetType: "RSVP", targetId: rsvp.id, metadata: { emailAdded: Boolean(newEmail) }, client: tx });
      return null;
    });
    if (refused) return { ok: false, error: refused };
  } catch (error) {
    if (error instanceof AdmissionError) return { ok: false, error: error.message };
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002") {
      return { ok: false, error: "That person is already registered for this event." };
    }
    throw error;
  }
  revalidatePath(`/order/${parsed.data.orderToken}`);
  return { ok: true };
}

const cancelSchema = z.object({ orderToken: z.string().trim().regex(/^[a-z0-9]{20,40}$/) }).strict();

/**
 * The buyer cancels their whole order, refunded as its refund policy (frozen
 * when they bought) allows. The order's access token is the proof.
 */
export async function cancelMyOrder(input: unknown): Promise<ActionResult> {
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Order not found." };
  if (await isActionRateLimited("rsvp", parsed.data.orderToken)) return { ok: false, error: "Too many attempts. Try again shortly." };
  const order = await prisma.order.findUnique({ where: { accessToken: parsed.data.orderToken }, select: { id: true } });
  if (!order) return { ok: false, error: "Order not found." };
  try {
    await cancelOrderAsBuyer({ orderId: order.id });
  } catch (error) {
    if (error instanceof PaymentOperationError) return { ok: false, error: error.message };
    throw error;
  }
  revalidatePath(`/order/${parsed.data.orderToken}`);
  return { ok: true };
}

const transferSchema = z.object({
  orderToken: z.string().trim().regex(/^[a-z0-9]{20,40}$/),
  rsvpId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1, "Enter the new holder's name.").max(200),
  email: z.string().trim().toLowerCase().email("Enter the new holder's email.").max(320),
}).strict();

/**
 * The buyer gives one person's ticket (every remaining date, for a pass) to
 * someone else, where the organiser allows it. The order's access token is
 * the proof.
 */
export async function transferOrderTicket(input: unknown): Promise<ActionResult> {
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the new holder's details." };
  if (await isActionRateLimited("rsvp", parsed.data.orderToken)) return { ok: false, error: "Too many attempts. Try again shortly." };
  if (!isValidAttendeeName(parsed.data.name)) return { ok: false, error: "Enter a valid name." };
  try {
    await transferTicket(parsed.data);
  } catch (error) {
    if (error instanceof PaymentOperationError) return { ok: false, error: error.message, ...(error instanceof AdmissionManagedError || error instanceof OpenClaimsError ? { code: error.code } : {}) };
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002") {
      return { ok: false, error: "That person already has a ticket for this event." };
    }
    throw error;
  }
  revalidatePath(`/order/${parsed.data.orderToken}`);
  return { ok: true };
}

