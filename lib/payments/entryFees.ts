import "server-only";

import { OrderStatus, PaymentStatus, SubmissionStatus, type Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import { enqueueSubmissionReceived } from "@/lib/outbox";
import { enqueuePaymentEmail } from "./email";

/**
 * Hackathon entry fees (docs/HACKATHON.md). Submitting a project on an event
 * with `submissionFeeMinor` first takes the fee through the normal checkout:
 * an order with no registrations, tied to the project (`Order.submissionId`).
 * The project is submitted when the payment lands, and stays paid for if it
 * is withdrawn and submitted again.
 */

export const ENTRY_FEE_LINE = "Project entry fee";

/** The project's fee is paid, waived or recorded by hand: a confirmed entry-fee order. */
export async function entryFeePaid(tx: Prisma.TransactionClient, submissionId: string) {
  return (await tx.order.count({ where: { submissionId, status: OrderStatus.CONFIRMED } })) > 0;
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
 * settled by the caller, which holds the event and order locks.
 */
export async function confirmEntryFeeTx(tx: Prisma.TransactionClient, order: { id: string; organisationId: string; submissionId: string; buyerEmail: string; buyerName: string; }, paymentId: string, now: Date, notifyPaid = true) {
  await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED, holdExpiresAt: null, holdCapAt: null } });
  const submitted = await tx.submission.updateMany({
    where: { id: order.submissionId, status: { in: [SubmissionStatus.DRAFT, SubmissionStatus.WITHDRAWN] } },
    data: { status: SubmissionStatus.SUBMITTED, submittedAt: now },
  });
  if (submitted.count === 1) await enqueueSubmissionReceived(tx, { to: order.buyerEmail, submissionId: order.submissionId, ...(order.buyerName ? { recipientName: order.buyerName.slice(0, 200) } : {}) });
  if (notifyPaid) await enqueuePaymentEmail(tx, { to: order.buyerEmail, paymentId, notice: "paid" });
  await recordAuditEvent({ action: "ENTRY_FEE_PAID", organisationId: order.organisationId, targetType: "Submission", targetId: order.submissionId, metadata: { orderId: order.id, submitted: submitted.count === 1 }, client: tx });
}

/** Settle a captured entry-fee payment from the provider: it is always accepted (no places are held). */
export async function settleEntryFeePayment(tx: Prisma.TransactionClient, payment: { id: string; organisationId: string; }, order: { id: string; submissionId: string; buyerEmail: string; buyerName: string; }, paid: { paymentId: string; }, now: Date) {
  await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.PAID_ONLINE, externalPaymentId: paid.paymentId, paidAt: now } });
  await confirmEntryFeeTx(tx, { ...order, organisationId: payment.organisationId }, payment.id, now);
}
