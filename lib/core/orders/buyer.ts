import "server-only";

import { cancelMyOrder, transferOrderTicket, updateOrderAttendee } from "@/app/actions/orders";
import type { ActionResult } from "@/app/actions/org";
import { prisma } from "@/lib/db";
import { startCheckout } from "@/lib/payments/checkout";
import { loadReceipt } from "@/lib/payments/receipts";
import { requestRefund } from "@/lib/refundRequests";

/*
 * Buyer operations for a signed-in buyer, by order id. The website proves a
 * buyer with the order's bearer link; a signed-in app proves it with the
 * account that bought. The access token is looked up here only to drive the
 * same code as the order page, and never leaves the server.
 */

const NOT_FOUND = { ok: false as const, error: "Order not found." };

async function buyerToken(orderId: string, buyerUserId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, buyerUserId }, select: { accessToken: true } });
  return order?.accessToken ?? null;
}

/** Cancel the whole order under its refund policy (as frozen at purchase). */
export async function cancelOrderForBuyer(orderId: string, buyerUserId: string): Promise<ActionResult> {
  const orderToken = await buyerToken(orderId, buyerUserId);
  return orderToken ? cancelMyOrder({ orderToken }) : NOT_FOUND;
}

/** Ask the organisers for a refund once the policy no longer allows one. */
export async function requestRefundForBuyer(orderId: string, buyerUserId: string, reason: unknown) {
  const orderToken = await buyerToken(orderId, buyerUserId);
  return orderToken ? requestRefund(orderToken, reason) : NOT_FOUND;
}

/** Give one holder's ticket to someone else, where the organiser allows it. */
export async function transferTicketForBuyer(orderId: string, buyerUserId: string, input: { rsvpId: string; name: string; email: string; }): Promise<ActionResult> {
  const orderToken = await buyerToken(orderId, buyerUserId);
  return orderToken ? transferOrderTicket({ orderToken, ...input }) : NOT_FOUND;
}

/** Name a ticket holder (and add their email while the ticket has none). */
export async function updateAttendeeForBuyer(orderId: string, buyerUserId: string, input: { rsvpId: string; name: string; email?: string; answers?: Record<string, unknown>; }): Promise<ActionResult> {
  const orderToken = await buyerToken(orderId, buyerUserId);
  return orderToken ? updateOrderAttendee({ orderToken, ...input }) : NOT_FOUND;
}

/** The receipt once money was collected; null otherwise. */
export async function receiptForBuyer(orderId: string, buyerUserId: string) {
  const orderToken = await buyerToken(orderId, buyerUserId);
  return orderToken ? loadReceipt(orderToken) : null;
}

/** Open (or reopen) the hosted payment page for a held order. */
export async function checkoutForBuyer(orderId: string, buyerUserId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, buyerUserId }, select: { id: true } });
  if (!order) return { error: "not_found" as const };
  return startCheckout(order.id).catch(() => ({ error: "unavailable" as const }));
}
