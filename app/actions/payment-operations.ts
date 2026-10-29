"use server";

import { EventPermission, OfflinePaymentMethod } from "@prisma/client";
import { revalidatePath as nextRevalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/app/actions/org";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canAccessEvent } from "@/lib/eventAccess";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { parseMoneyToMinor } from "@/lib/payments/money";
import { AdmissionManagedError, amendOfflinePayment, PaymentOperationError, refundOrder, retryFailedRefund, sendPaymentLink, settleOrderByHand } from "@/lib/payments/operations";
import { getMembership } from "@/lib/permissions";
import { hasRecentAuthentication } from "@/lib/reauth";
import { submitManualTicketOrderCore } from "@/lib/rsvpCore";
import { attendeeNameSchema } from "@/lib/validators";

const revalidatePath = trackedRevalidation(nextRevalidatePath);

/** An event, or a series (whose orders are for one date or a pass). */
const target = {
  organisationSlug: z.string().trim().min(1).max(120),
  eventId: z.string().trim().min(1).max(128).optional(),
  seriesId: z.string().trim().min(1).max(128).optional(),
};
type Target = { organisationSlug: string; eventId?: string; seriesId?: string; };
type Scope = { eventId: string; } | { eventSeriesId: string; };
const orderTarget = { ...target, orderId: z.string().trim().min(1).max(64) };
const offlineMethod = z.nativeEnum(OfflinePaymentMethod);
const reference = z.string().trim().max(120).nullable().optional();

/**
 * Refunds, offline payments, waivers, payment links and paid guests belong
 * to the organisation's owners and admins, and to collaborators granted
 * MANAGE_REGISTRATIONS on this event.
 */
async function access(input: Target) {
  const session = await auth();
  if (!session?.user?.id) return { error: "You must be signed in." } as const;
  if (Boolean(input.eventId) === Boolean(input.seriesId)) return { error: "Choose an event or a series." } as const;
  const userId = session.user.id;
  const scope: Scope = input.eventId ? { eventId: input.eventId } : { eventSeriesId: input.seriesId! };
  const organisation = await prisma.organisation.findUnique({ where: { slug: input.organisationSlug }, select: { id: true, slug: true } });
  if (!organisation || !(await canAccessEvent({ userId, organisationId: organisation.id, ...scope, permission: EventPermission.MANAGE_REGISTRATIONS }))) {
    return { error: "You don't have permission to manage payments for this event." } as const;
  }
  if (await isActionRateLimited("action", userId)) return { error: "Too many changes. Try again shortly." } as const;
  const path = "eventId" in scope ? `/dashboard/${organisation.slug}/event/${scope.eventId}` : `/dashboard/${organisation.slug}/series/${scope.eventSeriesId}`;
  return { organisation, userId, scope, path };
}

/** The order, only if it belongs to this event or series. */
async function orderOf(scope: Scope, orderId: string) {
  return prisma.order.findFirst({ where: { id: orderId, ...scope }, select: { id: true, currency: true } });
}

async function run(path: string, operation: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof PaymentOperationError) return { ok: false, error: error.message, ...(error instanceof AdmissionManagedError ? { code: error.code } : {}) };
    throw error;
  }
  revalidatePath(path);
  return { ok: true };
}

const refundSchema = z.object({
  ...orderTarget,
  /** Major units; blank refunds everything still refundable. */
  amount: z.string().trim().max(20).default(""),
  reason: z.string().trim().min(1, "Say why you're refunding.").max(500),
  cancelTickets: z.boolean().default(false),
}).strict();

export async function refundPaidOrder(input: unknown): Promise<ActionResult> {
  const parsed = refundSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the refund." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error ?? "Event not found." };
  const order = await orderOf(context.scope, parsed.data.orderId);
  if (!order) return { ok: false, error: "Order not found." };
  const amountMinor = parsed.data.amount ? parseMoneyToMinor(parsed.data.amount, order.currency) : null;
  if (parsed.data.amount && amountMinor == null) return { ok: false, error: `Enter the amount in ${order.currency}, for example 250.` };
  return run(context.path, () => refundOrder({
    orderId: order.id, organisationId: context.organisation.id, actorUserId: context.userId,
    amountMinor, reason: parsed.data.reason, cancelTickets: parsed.data.cancelTickets,
  }));
}

const retrySchema = z.object({ ...target, refundId: z.string().trim().min(1).max(64) }).strict();

/**
 * Retry a refund the provider refused (docs/PAYMENTS.md). Owners and admins
 * only (MANAGE_REGISTRATIONS collaborators can't), after a fresh sign-in.
 */
export async function retryFailedRefundAction(input: unknown): Promise<ActionResult> {
  const parsed = retrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose a refund." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error ?? "Event not found." };
  const membership = await getMembership(context.userId, context.organisation.id);
  if (membership?.role !== "OWNER" && membership?.role !== "ADMIN") return { ok: false, error: "Only the organisation's owners and admins can retry refunds." };
  if (!(await hasRecentAuthentication())) return { ok: false, error: "For security, sign in again before retrying a refund." };
  const refund = await prisma.paymentRefund.findFirst({ where: { id: parsed.data.refundId, payment: { organisationId: context.organisation.id, order: context.scope } }, select: { id: true } });
  if (!refund) return { ok: false, error: "Refund not found." };
  return run(context.path, () => retryFailedRefund({ refundId: refund.id, organisationId: context.organisation.id, actorUserId: context.userId }));
}

const settleSchema = z.object({
  ...orderTarget,
  mode: z.enum(["offline", "waive"]),
  method: offlineMethod.optional(),
  reference,
}).strict();

/** Record money collected in person, or make a pending order complimentary. */
export async function settlePaidOrder(input: unknown): Promise<ActionResult> {
  const parsed = settleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check how the order was paid." };
  if (parsed.data.mode === "offline" && !parsed.data.method) return { ok: false, error: "Choose how the money was collected." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error ?? "Event not found." };
  const order = await orderOf(context.scope, parsed.data.orderId);
  if (!order) return { ok: false, error: "Order not found." };
  return run(context.path, () => settleOrderByHand({
    orderId: order.id, organisationId: context.organisation.id, actorUserId: context.userId,
    mode: parsed.data.mode, method: parsed.data.method, reference: parsed.data.reference,
  }));
}

export async function sendOrderPaymentLink(input: unknown): Promise<ActionResult> {
  const parsed = z.object(orderTarget).strict().safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose an order." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error ?? "Event not found." };
  const order = await orderOf(context.scope, parsed.data.orderId);
  if (!order) return { ok: false, error: "Order not found." };
  return run(context.path, () => sendPaymentLink({ orderId: order.id, organisationId: context.organisation.id, actorUserId: context.userId }));
}

const amendSchema = z.object({
  ...target,
  paymentId: z.string().trim().min(1).max(64),
  method: offlineMethod.optional(),
  reference,
  reason: z.string().trim().min(1, "Say why the record is being corrected.").max(500),
}).strict();

/** Correct an offline payment's record; the original stays, with the change logged. */
export async function correctOfflinePayment(input: unknown): Promise<ActionResult> {
  const parsed = amendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the correction." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error ?? "Event not found." };
  const payment = await prisma.payment.findFirst({ where: { id: parsed.data.paymentId, order: context.scope }, select: { id: true } });
  if (!payment) return { ok: false, error: "Payment not found." };
  return run(context.path, () => amendOfflinePayment({
    paymentId: payment.id, organisationId: context.organisation.id, actorUserId: context.userId,
    method: parsed.data.method, reference: parsed.data.reference, reason: parsed.data.reason,
  }));
}

const guestSchema = z.object({
  ...target,
  name: attendeeNameSchema,
  guestEmail: z.string().trim().toLowerCase().email("Valid email required").max(320),
  ticketTypeId: z.string().trim().min(1).max(64),
  /** How a paid ticket is settled; ignored for free tickets. */
  payment: z.enum(["link", "offline", "waive"]).default("link"),
  method: offlineMethod.optional(),
  reference,
  answers: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

/**
 * Add a guest with a ticket: emailed a payment link (a day to pay), paid in
 * person, or complimentary. Like other manual additions it works for draft,
 * ended or invite-only events.
 */
export async function addTicketGuest(input: unknown): Promise<ActionResult<{ status: string; }>> {
  const parsed = guestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the guest's details." };
  if (parsed.data.payment === "offline" && !parsed.data.method) return { ok: false, error: "Choose how the money was collected." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error ?? "Event not found." };
  if (!("eventId" in context.scope)) return { ok: false, error: "Guests with tickets are added to events; series guests book a date or a pass." };
  const result = await submitManualTicketOrderCore({ ...parsed.data, eventId: context.scope.eventId }, { organisationId: context.organisation.id, actorUserId: context.userId });
  if (!result.ok) return result;
  revalidatePath(context.path);
  return { ok: true, data: { status: result.data!.status } };
}
