import "server-only";

import { PaymentRefundStatus, PaymentStatus, type Prisma } from "@prisma/client";
import { isPaidEventsEnabled } from "@/lib/instanceSettings";
import { loadPaymentAccount } from "../settings";
import { lockOrderTargets, orderSubject } from "../targets";

/** An organiser operation was refused; the message is safe to show. */
export class PaymentOperationError extends Error {}

/**
 * The order pays for an application's place (docs/ADMISSION.md): it is held
 * and paid only through the applicant's accepted offer, never by an
 * organiser's payment link or approval. `code` lets the mobile API answer
 * ADMISSION_MANAGED.
 */
export class AdmissionManagedError extends PaymentOperationError {
  readonly code = "ADMISSION_MANAGED";
  constructor(message = "This order pays for an application. It's paid when the applicant accepts their offer, from the Applications tab or their ticket page.") {
    super(message);
  }
}

/** Whether an order belongs to an application (its registration's, or its team's). */
export async function isAdmissionOrder(client: Prisma.TransactionClient, orderId: string): Promise<boolean> {
  const order = await client.order.findUnique({ where: { id: orderId }, select: { teamId: true, rsvps: { select: { admissionApplication: { select: { id: true } } } } } });
  if (!order) return false;
  if (order.rsvps.some((rsvp) => rsvp.admissionApplication)) return true;
  return order.teamId ? (await client.admissionApplication.count({ where: { teamId: order.teamId } })) > 0 : false;
}

export const ZERO = BigInt(0);
export const COLLECTED: PaymentStatus[] = [PaymentStatus.PAID_ONLINE, PaymentStatus.PAID_OFFLINE];
export const COMMITTED_REFUND: PaymentRefundStatus[] = [PaymentRefundStatus.PENDING, PaymentRefundStatus.SUCCEEDED];

/** Lock order everywhere: the event row (or the series, then its dates), then the order. */
export async function lockOrder(tx: Prisma.TransactionClient, orderId: string) {
  const row = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, eventId: true, eventSeriesId: true } });
  if (row) await lockOrderTargets(tx, row);
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
}

export const subjectTitle = (order: Parameters<typeof orderSubject>[0]) => orderSubject(order)?.title ?? "your event";

export async function onlineAccount(organisationId: string) {
  if (!(await isPaidEventsEnabled())) throw new PaymentOperationError("Paid events are turned off for this installation.");
  const account = await loadPaymentAccount(organisationId);
  if (!account) throw new PaymentOperationError("Connect a payment account in the organisation's payment settings first.");
  return account;
}

export function attendeeEmail(rsvp: { guestEmail: string | null; user: { email: string | null; } | null; }) {
  return rsvp.user?.email?.trim() || rsvp.guestEmail;
}
