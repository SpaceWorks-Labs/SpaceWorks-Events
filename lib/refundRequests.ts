import "server-only";

import { OrderStatus, PaymentStatus, RefundRequestStatus, type Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { noticeEach, noticeSubject, organiserEmails } from "@/lib/notices";
import { formatMoney, parseMoneyToMinor } from "@/lib/payments/money";
import { PaymentOperationError, refundOrder } from "@/lib/payments/operations";
import { orderSubject, ORDER_SUBJECT_SELECT } from "@/lib/payments/targets";
import type { ClaimAdminContext } from "@/lib/claims/decide";

/**
 * Refund requests (docs/FINANCE.md): a buyer asks for money back outside the
 * automatic refund policy from their order page; an owner or admin approves
 * (the normal refund, in full or in part, optionally cancelling the
 * tickets) or declines with a reason. One open request per order.
 */

type Result = { ok: true; } | { ok: false; error: string; };
const reasonSchema = z.string().trim().min(1, "Say why you're asking for a refund.").max(1000);
export const decideRefundSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  decision: z.enum(["approve", "decline"]),
  /** Blank refunds everything still refundable. */
  amount: z.string().trim().max(20).default(""),
  cancelTickets: z.boolean().default(false),
  note: z.string().trim().max(500).default(""),
}).strict();

const ORDER_FOR_REQUEST = { id: true, organisationId: true, status: true, reference: true, buyerName: true, ...ORDER_SUBJECT_SELECT, payments: { where: { status: { in: [PaymentStatus.PAID_ONLINE, PaymentStatus.PAID_OFFLINE] } }, select: { id: true } } } satisfies Prisma.OrderSelect;

/** The buyer asks, holding the order's bearer link. */
export async function requestRefund(orderToken: string, reason: unknown): Promise<Result> {
  const parsedReason = reasonSchema.safeParse(reason);
  if (!parsedReason.success) return { ok: false, error: parsedReason.error.issues[0]?.message ?? "Say why." };
  const order = await prisma.order.findUnique({ where: { accessToken: orderToken }, select: ORDER_FOR_REQUEST });
  return openRefundRequest(order, parsedReason.data);
}

/**
 * Open a refund request for an order without its bearer link: a guest who
 * answered "No" to attendance confirmation after the refund policy closed
 * (docs/ATTENDANCE.md). The caller has already authorised the guest (their
 * attendance link) and checked they bought the order. Same rules as the
 * buyer's own request: paid, confirmed orders only, one open request each.
 * `onCreated` runs in the request's own transaction (the attendance check
 * records which request it opened).
 */
export async function requestRefundForOrder(orderId: string, reason: string, onCreated?: (tx: Prisma.TransactionClient, requestId: string) => Promise<unknown>): Promise<Result> {
  const parsedReason = reasonSchema.safeParse(reason);
  if (!parsedReason.success) return { ok: false, error: parsedReason.error.issues[0]?.message ?? "Say why." };
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: ORDER_FOR_REQUEST });
  return openRefundRequest(order, parsedReason.data, onCreated);
}

async function openRefundRequest(order: Prisma.OrderGetPayload<{ select: typeof ORDER_FOR_REQUEST; }> | null, reason: string, onCreated?: (tx: Prisma.TransactionClient, requestId: string) => Promise<unknown>): Promise<Result> {
  if (!order) return { ok: false, error: "Order not found." };
  if (order.status !== OrderStatus.CONFIRMED || order.payments.length === 0) return { ok: false, error: "Only paid orders can ask for a refund." };
  const title = orderSubject(order)?.title ?? "your event";
  try {
    await prisma.$transaction(async (tx) => {
      const request = await tx.refundRequest.create({ data: { organisationId: order.organisationId, orderId: order.id, reason }, select: { id: true } });
      await recordAuditEvent({ action: "REFUND_REQUESTED", organisationId: order.organisationId, targetType: "RefundRequest", targetId: request.id, metadata: { orderId: order.id }, client: tx });
      await onCreated?.(tx, request.id);
      await notifyChat(tx, order.organisationId, "claim", `${order.buyerName || "A buyer"} asked for a refund on order ${order.reference} (${title}).`);
      await noticeEach(tx, await organiserEmails(tx, order.organisationId), {
        organisationId: order.organisationId,
        subject: noticeSubject("Refund request", title),
        lines: [`${order.buyerName || "A buyer"} asked for a refund on order ${order.reference}: ${reason}`, "Approve or decline it from the event's Finance tab."],
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: ALREADY_REQUESTED };
    throw error;
  }
  return { ok: true };
}

export const ALREADY_REQUESTED = "You've already asked; the organisers will reply by email.";

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

/** An owner or admin approves (running the refund) or declines a request. */
export async function decideRefundRequest(ctx: ClaimAdminContext, input: unknown): Promise<Result> {
  const parsed = decideRefundSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the decision." };
  const { requestId, decision, note } = parsed.data;
  const request = await prisma.refundRequest.findFirst({
    where: { id: requestId, organisationId: ctx.organisationId },
    select: { id: true, reason: true, order: { select: { id: true, reference: true, buyerEmail: true, currency: true, ...ORDER_SUBJECT_SELECT } } },
  });
  if (!request) return { ok: false, error: "Request not found." };
  const title = orderSubject(request.order)?.title ?? "your event";
  if (decision === "decline") {
    if (!note) return { ok: false, error: "Say why the refund is declined." };
    return prisma.$transaction(async (tx): Promise<Result> => {
      const claimed = await tx.refundRequest.updateMany({ where: { id: request.id, status: RefundRequestStatus.OPEN }, data: { status: RefundRequestStatus.DECLINED, decisionNote: note, decidedByUserId: ctx.userId, decidedAt: new Date() } });
      if (claimed.count !== 1) return { ok: false, error: "This request was already decided." };
      await recordAuditEvent({ action: "REFUND_REQUEST_DECLINED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "RefundRequest", targetId: request.id, client: tx });
      await noticeEach(tx, [request.order.buyerEmail], { organisationId: ctx.organisationId, subject: noticeSubject("Refund request", title), lines: [`Your refund request for order ${request.order.reference} wasn't approved.`, `Reason: ${note}`] });
      return { ok: true };
    });
  }
  const amountMinor = parsed.data.amount ? parseMoneyToMinor(parsed.data.amount, request.order.currency) : null;
  if (parsed.data.amount && (amountMinor == null || amountMinor <= BigInt(0))) return { ok: false, error: `Enter the amount in ${request.order.currency}, or leave it blank to refund everything.` };
  // Claim the request first so two approvals never refund twice; release it if the refund is refused.
  const claimed = await prisma.refundRequest.updateMany({ where: { id: request.id, status: RefundRequestStatus.OPEN }, data: { status: RefundRequestStatus.APPROVED, approvedMinor: amountMinor, cancelTickets: parsed.data.cancelTickets, decisionNote: note, decidedByUserId: ctx.userId, decidedAt: new Date() } });
  if (claimed.count !== 1) return { ok: false, error: "This request was already decided." };
  let refunded: { refundedMinor: bigint; };
  try {
    refunded = await refundOrder({ orderId: request.order.id, organisationId: ctx.organisationId, actorUserId: ctx.userId, amountMinor, reason: `Refund request: ${request.reason}`, cancelTickets: parsed.data.cancelTickets });
  } catch (error) {
    // Only a refusal happens before the refund commits; then the request is
    // open again. Anything later leaves it approved, so it never refunds twice.
    if (!(error instanceof PaymentOperationError)) throw error;
    await prisma.refundRequest.update({ where: { id: request.id }, data: { status: RefundRequestStatus.OPEN, approvedMinor: null, decidedByUserId: null, decidedAt: null, decisionNote: "" } });
    return { ok: false, error: error.message };
  }
  await prisma.refundRequest.update({ where: { id: request.id }, data: { approvedMinor: refunded.refundedMinor } });
  await recordAuditEvent({ action: "REFUND_REQUEST_APPROVED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "RefundRequest", targetId: request.id, metadata: { amountMinor: amountMinor?.toString() ?? "all", cancelTickets: parsed.data.cancelTickets } });
  return { ok: true };
}

/** For the order page: the buyer's latest request on this order, if any. */
export async function latestRefundRequest(orderId: string) {
  const request = await prisma.refundRequest.findFirst({ where: { orderId }, orderBy: { createdAt: "desc" }, select: { status: true, decisionNote: true, approvedMinor: true, order: { select: { currency: true } } } });
  if (!request) return null;
  return { status: request.status, note: request.decisionNote, approved: request.approvedMinor != null ? formatMoney(request.approvedMinor, request.order.currency) : null };
}
