import "server-only";

import { EventStatus, OrderStatus, PaymentRefundStatus, PaymentStatus, SubmissionStatus, type Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import { enqueueSubmissionReceived } from "@/lib/outbox";
import { shouldQueueSubmissionReceipt } from "@/lib/hackathonEmails";
import { enqueuePaymentEmail } from "./email";
import { createPendingRefund } from "./refunds";
import { PaymentOperationError } from "./operations/shared";
import { resultsFreezeSubmissions } from "@/lib/core/judging/shared";

/**
 * Hackathon entry fees (docs/HACKATHON.md). Submitting a project on an event
 * with `submissionFeeMinor` first takes the fee through the normal checkout:
 * an order with no registrations, tied to the project (`Order.submissionId`).
 * The project is submitted when the payment lands, and stays paid for if it
 * is withdrawn and submitted again.
 */

export const ENTRY_FEE_LINE = "Project entry fee";

/** The project's fee is paid (or waived) and not refunded in full: a confirmed entry-fee order still holding money. */
export async function entryFeePaid(tx: Prisma.TransactionClient, submissionId: string) {
  const orders = await tx.order.findMany({
    where: { submissionId, status: OrderStatus.CONFIRMED },
    select: { payments: { where: { status: { in: [PaymentStatus.PAID_ONLINE, PaymentStatus.PAID_OFFLINE, PaymentStatus.WAIVED] } }, select: { status: true, amountMinor: true, refunds: { where: { status: { in: [PaymentRefundStatus.PENDING, PaymentRefundStatus.SUCCEEDED] } }, select: { amountMinor: true } } } } },
  });
  return orders.some((order) => order.payments.some((payment) => payment.status === PaymentStatus.WAIVED || payment.amountMinor > payment.refunds.reduce((sum, refund) => sum + refund.amountMinor, BigInt(0))));
}

/** The fee owed before this project can be submitted, or null when there is none (or it is paid). */
export async function entryFeeOwed(tx: Prisma.TransactionClient, eventId: string, submissionId: string | null) {
  const event = await tx.event.findUnique({ where: { id: eventId }, select: { submissionFeeMinor: true } });
  if (!event?.submissionFeeMinor) return null;
  if (submissionId && await entryFeePaid(tx, submissionId)) return null;
  return event.submissionFeeMinor;
}

/**
 * The fee was paid (online, by hand, or waived): confirm the order and
 * submit its project, unless it was disqualified or deleted meanwhile (the
 * money stays recorded; the organiser decides). The payment row is already
 * settled by the caller, which holds the event and order locks. The submission receipt
 * is opt-in per event (`emailSubmissionReceipts`, lib/hackathonEmails.ts),
 * read in this transaction; the payment email is never gated. A cancelled
 * event never takes a project in: callers refund the fee (settlement) or
 * refuse (settling by hand) first, and this refuses too. Once results are
 * published the project is frozen, so a late fee is kept but submits nothing.
 */
export async function confirmEntryFeeTx(tx: Prisma.TransactionClient, order: { id: string; organisationId: string; submissionId: string; buyerEmail: string; buyerName: string; }, paymentId: string, now: Date, notifyPaid = true) {
  const submission = await tx.submission.findUnique({ where: { id: order.submissionId }, select: { event: { select: { status: true, resultsPublishedAt: true } } } });
  if (submission?.event.status === EventStatus.CANCELLED) throw new PaymentOperationError("This event was cancelled, so the project can't be submitted.");
  await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED, holdExpiresAt: null, holdCapAt: null } });
  // Published results freeze projects (docs/HACKATHON.md): the fee stays recorded, the project isn't submitted.
  const submitted = submission && resultsFreezeSubmissions(submission.event) ? { count: 0 } : await tx.submission.updateMany({
    where: { id: order.submissionId, status: { in: [SubmissionStatus.DRAFT, SubmissionStatus.WITHDRAWN] } },
    data: { status: SubmissionStatus.SUBMITTED, submittedAt: now },
  });
  const receipts = submitted.count === 1 ? await tx.submission.findUnique({ where: { id: order.submissionId }, select: { event: { select: { emailSubmissionReceipts: true } } } }) : null;
  if (receipts && shouldQueueSubmissionReceipt(receipts.event)) await enqueueSubmissionReceived(tx, { to: order.buyerEmail, submissionId: order.submissionId, ...(order.buyerName ? { recipientName: order.buyerName.slice(0, 200) } : {}) });
  if (notifyPaid) await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId, notice: "paid" });
  await recordAuditEvent({ action: "ENTRY_FEE_PAID", organisationId: order.organisationId, targetType: "Submission", targetId: order.submissionId, metadata: { orderId: order.id, submitted: submitted.count === 1 }, client: tx });
}

/**
 * Settle a captured entry-fee payment from the provider. No places are held,
 * so it is accepted even after its hold ended, unless the fee was meanwhile
 * paid on another order: then this payment is refunded in full. Returns the
 * refund to submit, if any.
 */
export async function settleEntryFeePayment(tx: Prisma.TransactionClient, payment: { id: string; organisationId: string; amountMinor: bigint; }, order: { id: string; submissionId: string; buyerEmail: string; buyerName: string; }, paid: { paymentId: string; }, now: Date) {
  await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.PAID_ONLINE, externalPaymentId: paid.paymentId, paidAt: now } });
  if (await entryFeePaid(tx, order.submissionId)) {
    const refund = await createPendingRefund(tx, { paymentId: payment.id, amountMinor: payment.amountMinor, reason: "Entry fee already paid on another order", automatic: true });
    await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId: payment.id, notice: "late-refund" });
    await recordAuditEvent({ action: "PAYMENT_DUPLICATE_REFUNDED", organisationId: payment.organisationId, targetType: "Payment", targetId: payment.id, client: tx });
    return refund.id;
  }
  await confirmEntryFeeTx(tx, { ...order, organisationId: payment.organisationId }, payment.id, now);
  return null;
}
